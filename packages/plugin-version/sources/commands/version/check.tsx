import {WorkspaceRequiredError}                                                                                                                   from '@yarnpkg/cli';
import {CommandContext, Configuration, MessageName, Project, StreamReport, Workspace, execUtils, structUtils, Manifest, LocatorHash, ThrowReport} from '@yarnpkg/core';
import {Filename, PortablePath, npath, ppath, xfs}                                                                                                from '@yarnpkg/fslib';
import {Command, UsageError}                                                                                                                      from 'clipanion';
import {AppContext, Box, Color, StdinContext, render}                                                                                             from 'ink';
import React, {useCallback, useContext, useEffect, useState}                                                                                      from 'react';
import semver                                                                                                                                     from 'semver';

type Decision = 'undecided' | 'decline' | 'major' | 'minor' | 'patch' | 'prerelease';
type Decisions = Map<Workspace, Decision>;
type Status = {decided: Array<Workspace >, undecided: Array<Workspace>, declined: Array<Workspace>};

// eslint-disable-next-line arca/no-default-export
export default class VersionApplyCommand extends Command<CommandContext> {
  @Command.Boolean(`-i,--interactive`)
  interactive?: boolean;

  static usage = Command.Usage({
    category: `Release-related commands`,
    description: `check that all the relevant packages have been bumped`,
    details: `
      **Warning:** This command currently requires Git.

      This command will check that all the packages covered by the files listed in argument have been properly bumped or declined to bump.

      In the case of a bump, the check will also cover transitive packages - meaning that should \`Foo\` be bumped, a package \`Bar\` depending on \`Foo\` will require a decision as to whether \`Bar\` will need to be bumped. This check doesn't cross packages that have declined to bump.

      In case no arguments are passed to the function, the list of modified files will be generated by comparing the HEAD against \`master\`.
    `,
    examples: [[
      `Check whether the modified packages need a bump`,
      `yarn version check`,
    ]],
  });

  @Command.Path(`version`, `check`)
  async execute() {
    if (this.interactive) {
      return await this.executeInteractive();
    } else {
      return await this.executeStandard();
    }
  }

  async executeInteractive() {
    const configuration = await Configuration.find(this.context.cwd, this.context.plugins);
    const {project, workspace} = await Project.find(configuration, this.context.cwd);

    if (!workspace)
      throw new WorkspaceRequiredError(this.context.cwd);

    await project.resolveEverything({
      lockfileOnly: true,
      report: new ThrowReport(),
    });

    const root = await fetchRoot(this.context.cwd);
    const base = await fetchBase(root);

    const files = await fetchChangedFiles(root, {base: base.hash});
    const workspaces = [...new Set(files.map(file => project.getWorkspaceByFilePath(file)))];
    if (workspaces.length === 0)
      return;

    const status = await fetchWorkspacesStatus(workspaces, {root, base: base.hash});
    if (status.undecided.length === 0)
      if (fetchUndecidedDependentWorkspaces(status, {project}).length === 0)
        return;

    const useListInput = function <T>(value: T, values: Array<T>, {active, minus, plus, set}: {active: boolean, minus: string, plus: string, set: (value: T) => void}) {
      const {stdin} = useContext(StdinContext);

      useEffect(() => {
        if (!active)
          return;

        const cb = (ch: any, key: any) => {
          const index = values.indexOf(value);
          switch (key.name) {
            case minus: {
              set(values[(values.length + index - 1) % values.length]);
            } break;
            case plus: {
              set(values[(index + 1) % values.length]);
            } break;
          }
        };

        stdin.on(`keypress`, cb);
        return () => {
          stdin.off(`keypress`, cb);
        };
      }, [values, value, active]);
    };

    const Undecided = ({workspace, active, decision, setDecision}: {workspace: Workspace, active: boolean, decision: Decision, setDecision: (decision: Decision) => void}) => {
      const currentVersion = workspace.manifest.version;
      if (currentVersion === null)
        throw new Error(`Assertion failed: The version should have been set`);

      const strategies: Array<Decision> = semver.prerelease(currentVersion) === null
        ? [`undecided`, `decline`, `patch`, `minor`, `major`, `prerelease`]
        : [`undecided`, `decline`, `prerelease`, `major`];

      useListInput(decision, strategies, {
        active,
        minus: `left`,
        plus: `right`,
        set: setDecision,
      });

      const nextVersion = decision === `undecided`
        ? <Color yellow>{currentVersion}</Color>
        : decision === `decline`
          ? <Color green>{currentVersion}</Color>
          : <><Color magenta>{currentVersion}</Color> → <Color green>{semver.inc(currentVersion, decision)}</Color></>;

      return <Box marginBottom={1}>
        <Box marginLeft={2} marginRight={2}>
          {active ? <Color cyan>▶</Color> : ` `}
        </Box>
        <Box flexDirection={`column`}>
          <Box>
            {structUtils.prettyLocator(configuration, workspace.anchoredLocator)} - {nextVersion}
          </Box>
          <Box>
            {strategies.map(strategy => {
              if (strategy === decision) {
                return <Box key={strategy} paddingLeft={2}><Color green>◼</Color> {strategy}</Box>;
              } else {
                return <Box key={strategy} paddingLeft={2}><Color yellow>◻</Color> {strategy}</Box>;
              }
            })}
          </Box>
        </Box>
      </Box>;
    };

    const useDecisions = (): [Map<Workspace, Decision>, (workspace: Workspace, decision: Decision) => void] => {
      const [decisions, setDecisions] = useState<Map<Workspace, Decision>>(new Map());

      const setDecision = useCallback((workspace: Workspace, decision: Decision) => {
        const copy = new Map(decisions);

        if (decision !== `undecided`)
          copy.set(workspace, decision);
        else
          copy.delete(workspace);

        setDecisions(copy);
      }, [decisions, setDecisions]);

      return [decisions, setDecision];
    };

    const applyDecisions = (status: Status, decisions: Decisions) => {
      const decidedWithDecisions = [...status.decided];
      const declinedWithDecisions = [...status.declined];

      for (const [workspace, decision] of decisions) {
        if (decision === `undecided`)
          continue;

        if (decision !== `decline`) {
          decidedWithDecisions.push(workspace);
        } else {
          declinedWithDecisions.push(workspace);
        }
      }

      const undecidedDependents = fetchUndecidedDependentWorkspaces({
        decided: decidedWithDecisions,
        declined: declinedWithDecisions,
      }, {project, include: new Set(decisions.keys())});

      const undecidedDependentsNoDuplicates: Array<Workspace> = [];
      for (const [workspace] of undecidedDependents)
        if (!undecidedDependentsNoDuplicates.includes(workspace))
          undecidedDependentsNoDuplicates.push(workspace);

      return {
        undecidedWorkspaces: status.undecided,
        undecidedDependents: undecidedDependentsNoDuplicates,
        fullListing: new Map([
          ...status.undecided.map(workspace => {
            return [`undecidedWorkspace:${workspace.anchoredLocator.locatorHash}`, workspace] as [string, Workspace];
          }),
          ...undecidedDependentsNoDuplicates.map(workspace => {
            return [`undecidedDependent:${workspace.anchoredLocator.locatorHash}`, workspace] as [string, Workspace];
          }),
        ]),
      };
    };

    const App = ({status, useSubmit}: {status: Status, useSubmit: (value: Decisions) => void}) => {
      const {setRawMode} = useContext(StdinContext);
      useEffect(() => {
        if (setRawMode) {
          setRawMode(true);
        }
      }, []);

      const [decisions, setDecision] = useDecisions();
      useSubmit(decisions);

      const {
        undecidedWorkspaces,
        undecidedDependents,
        fullListing,
      } = applyDecisions(status, decisions);

      const keys = [...fullListing.keys()];
      const initialKey = keys[0];

      const [activeKey, setActiveKey] = useState(initialKey);
      const activeWorkspace = fullListing.get(activeKey);

      useListInput(activeKey, keys, {
        active: true,
        minus: `up`,
        plus: `down`,
        set: setActiveKey,
      });

      return <Box width={80} flexDirection={`column`}>
        <Box textWrap={`wrap`}>
          The following files have been modified in your local checkout.
        </Box>
        <Box flexDirection={`column`} marginTop={1} marginBottom={1} paddingLeft={2}>
          {files.map(file => <Box key={file}>
            <Color grey>{root}</Color>/{ppath.relative(root, file)}
          </Box>)}
        </Box>
        {undecidedWorkspaces.length > 0 && <>
          <Box textWrap={`wrap`}>
            Because of those files having been modified, the following workspaces may need to be released again (note that private workspaces are also shown here, because even though they won't be published, bumping them will allow us to flag their dependents for potential re-release):
          </Box>
          <Box marginTop={1} flexDirection={`column`}>
            {undecidedWorkspaces.map(workspace => {
              return <Undecided key={workspace.cwd} workspace={workspace} active={workspace === activeWorkspace} decision={decisions.get(workspace) || `undecided`} setDecision={decision => setDecision(workspace, decision)} />;
            })}
          </Box>
        </>}
        {undecidedDependents.length > 0 && <>
          <Box textWrap={`wrap`}>
            The following workspaces depend on other workspaces that have been bumped, and thus may need to receive a bump of their own:
          </Box>
          <Box marginTop={1} flexDirection={`column`}>
            {undecidedDependents.map(workspace => {
              return <Undecided key={workspace.cwd} workspace={workspace} active={workspace === activeWorkspace} decision={decisions.get(workspace) || `undecided`} setDecision={decision => setDecision(workspace, decision)} />;
            })}
          </Box>
        </>}
      </Box>;
    };

    const renderForm = async function <T>(UserComponent: any, props: any) {
      let returnedValue: T | undefined;

      const {waitUntilExit} = render(React.cloneElement(<UserComponent {...props}/>, {
        useSubmit(value: T) {
          const {exit} = useContext(AppContext);
          const {stdin} = useContext(StdinContext);

          useEffect(() => {
            const cb = (ch: any, key: any) => {
              if (key.name === `return`) {
                returnedValue = value;
                exit();
              }
            };

            stdin.on(`keypress`, cb);
            return () => {
              stdin.off(`keypress`, cb);
            };
          }, [stdin, exit, value]);
        },
      }));

      await waitUntilExit();
      return returnedValue;
    };

    const decisions = await renderForm<Decisions>(App, {status});
    if (typeof decisions === `undefined`)
      return 1;

    for (const [workspace, decision] of decisions.entries()) {
      if (decision !== `undecided`) {
        await this.cli.run([workspace.cwd, `version`, decision, `--deferred`]);
      }
    }
  }

  async executeStandard() {
    const configuration = await Configuration.find(this.context.cwd, this.context.plugins);
    const {project, workspace} = await Project.find(configuration, this.context.cwd);

    if (!workspace)
      throw new WorkspaceRequiredError(this.context.cwd);

    await project.resolveEverything({
      lockfileOnly: true,
      report: new ThrowReport(),
    });

    const report = await StreamReport.start({
      configuration,
      stdout: this.context.stdout,
    }, async report => {
      const root = await fetchRoot(this.context.cwd);
      const base = await fetchBase(root);

      const files = await fetchChangedFiles(root, {base: base.hash});
      const workspaces = [...new Set(files.map(file => project.getWorkspaceByFilePath(file)))];

      let hasDiffErrors = false;
      let hasDepsErrors = false;

      report.reportInfo(MessageName.UNNAMED, `Your PR was started right after ${configuration.format(base.hash.slice(0, 7), `yellow`)} ${configuration.format(base.message, `magenta`)}`);

      if (files.length > 0) {
        report.reportInfo(MessageName.UNNAMED, `you have changed the following files since then:`);
        for (const file of files) {
          report.reportInfo(null, file);
        }
      }

      const status = await fetchWorkspacesStatus(workspaces, {root, base: base.hash});

      if (status.undecided.length > 0) {
        if (!hasDiffErrors && files.length > 0)
          report.reportSeparator();

        for (const workspace of status.undecided)
          report.reportError(MessageName.UNNAMED, `${structUtils.prettyLocator(configuration, workspace.anchoredLocator)} has been modified but doesn't have a bump strategy attached`);

        hasDiffErrors = true;
      }

      const undecidedDependents = await fetchUndecidedDependentWorkspaces(status, {project});

      // Then we check which workspaces depend on packages that will be released again but have no release strategies themselves
      for (const [workspace, dependency] of undecidedDependents) {
        if (!hasDepsErrors && (files.length > 0 || hasDiffErrors))
          report.reportSeparator();

        report.reportError(MessageName.UNNAMED, `${structUtils.prettyLocator(configuration, workspace.anchoredLocator)} doesn't have a bump strategy attached, but depends on ${structUtils.prettyWorkspace(configuration, dependency)} which will be re-released.`);
        hasDepsErrors = true;
      }

      if (hasDiffErrors || hasDepsErrors) {
        report.reportSeparator();

        report.reportInfo(MessageName.UNNAMED, `This command detected that at least some workspaces have received modifications but no explicit instructions as to how they had to be released (if needed).`);
        report.reportInfo(MessageName.UNNAMED, `To correct these errors, run \`yarn version ... --deferred\` in each of them with the adequate bump strategies, then run \`yarn version check\` again.`);
      }
    });

    return report.exitCode();
  }
}

async function fetchWorkspacesStatus(workspaces: Array<Workspace>, {root, base}: { root: PortablePath, base: string }): Promise<Status> {
  const decided: Array<Workspace> = [];
  const undecided: Array<Workspace> = [];
  const declined: Array<Workspace> = [];

  // First we check which workspaces have received modifications but no release strategies
  for (const workspace of workspaces) {
    // Let's assume that packages without versions don't need to see their version increased
    if (workspace.manifest.version === null)
      continue;

    const currentNonce = getNonce(workspace.manifest);
    const previousNonce = await fetchPreviousNonce(workspace, {root, base});

    // If the nonce is the same, it means that the user didn't run one of the `yarn version <>` variants since they started working on this diff
    if (currentNonce === previousNonce) {
      undecided.push(workspace);
    } else {
      if (willBeReleased(workspace.manifest)) {
        decided.push(workspace);
      } else {
        declined.push(workspace);
      }
    }
  }

  return {decided, undecided, declined};
}

function fetchUndecidedDependentWorkspaces({decided, declined}: {decided: Array<Workspace>, declined: Array<Workspace>}, {project, include = new Set()}: {project: Project, include?: Set<Workspace>}) {
  const undecided = [];

  const bumpedWorkspaces = new Map(decided.map<[LocatorHash, Workspace]>(workspace => {
    return [workspace.anchoredLocator.locatorHash, workspace];
  }));

  const declinedWorkspaces = new Map(declined.map<[LocatorHash, Workspace]>(workspace => {
    return [workspace.anchoredLocator.locatorHash, workspace];
  }));

  // Then we check which workspaces depend on packages that will be released again but have no release strategies themselves
  for (const workspace of project.workspaces) {
    // We allow to overrule the following check because the interactive mode wants to keep displaying the previously-undecided packages even after they have been decided
    if (!include.has(workspace)) {
      // We don't need to run the check for packages that have already been decided
      if (declinedWorkspaces.has(workspace.anchoredLocator.locatorHash))
        continue;
      if (bumpedWorkspaces.has(workspace.anchoredLocator.locatorHash)) {
        continue;
      }
    }

    // We also don't need to run the check for private packages (is that true? I'm not really sure)
    if (workspace.manifest.private)
      continue;

    // Let's assume that packages without versions don't need to see their version increased
    if (workspace.manifest.version === null)
      continue;

    for (const descriptor of workspace.dependencies.values()) {
      const resolution = project.storedResolutions.get(descriptor.descriptorHash);
      if (typeof resolution === `undefined`)
        throw new Error(`Assertion failed: The resolution should have been registered`);

      const pkg = project.storedPackages.get(resolution);
      if (typeof pkg === `undefined`)
        throw new Error(`Assertion failed: The package should have been registered`);

      // We only care about workspaces, and we only care about workspaces that will be bumped
      if (!bumpedWorkspaces.has(resolution))
        continue;

      // Quick note: we don't want to check whether the workspace pointer
      // by `resolution` is private, because while it doesn't makes sense
      // to bump a private package because its dependencies changed, the
      // opposite isn't true: a (public) package might need to be bumped
      // because one of its dev dependencies is a (private) package whose
      // behavior sensibly changed.

      undecided.push([workspace, bumpedWorkspaces.get(resolution)!]);
    }
  }

  return undecided;
}

async function fetchBase(root: PortablePath) {
  const candidateBases = [`master`, `origin/master`, `upstream/master`];
  const ancestorBases = [];

  for (const candidate of candidateBases) {
    const {code} = await execUtils.execvp(`git`, [`merge-base`, candidate, `HEAD`], {cwd: root});
    if (code === 0) {
      ancestorBases.push(candidate);
    }
  }

  if (ancestorBases.length === 0)
    throw new UsageError(`No ancestor could be found between any of HEAD and ${candidateBases.join(`, `)}`);

  const {stdout: mergeBaseStdout} = await execUtils.execvp(`git`, [`merge-base`, `HEAD`, ...ancestorBases], {cwd: root, strict: true});
  const hash = mergeBaseStdout.trim();

  const {stdout: showStdout} = await execUtils.execvp(`git`, [`show`, `--quiet`, `--pretty=format:%s`, hash], {cwd: root, strict: true});
  const message = showStdout.trim();

  return {hash, message};
}

async function fetchRoot(initialCwd: PortablePath) {
  // Note: We can't just use `git rev-parse --show-toplevel`, because on Windows
  // it may return long paths even when the cwd uses short paths, and we have no
  // way to detect it from Node (not even realpath).

  let match: PortablePath | null = null;

  let cwd: PortablePath;
  let nextCwd = initialCwd;
  do {
    cwd = nextCwd;
    if (await xfs.existsPromise(ppath.join(cwd, `.git` as Filename)))
      match = cwd;
    nextCwd = ppath.dirname(cwd);
  } while (match === null && nextCwd !== cwd);

  if (match === null)
    throw new UsageError(`This command can only be run from within a Git repository`);

  return match;
}

async function fetchChangedFiles(root: PortablePath, {base}: {base: string}) {
  const {stdout: localStdout} = await execUtils.execvp(`git`, [`diff`, `--name-only`, `${base}`], {cwd: root, strict: true});
  const trackedFiles = localStdout.split(/\r\n|\r|\n/).filter(file => file.length > 0).map(file => ppath.resolve(root, npath.toPortablePath(file)));

  const {stdout: untrackedStdout} = await execUtils.execvp(`git`, [`ls-files`, `--others`, `--exclude-standard`], {cwd: root, strict: true});
  const untrackedFiles = untrackedStdout.split(/\r\n|\r|\n/).filter(file => file.length > 0).map(file => ppath.resolve(root, npath.toPortablePath(file)));

  return [...new Set([...trackedFiles, ...untrackedFiles].sort())];
}

async function fetchPreviousNonce(workspace: Workspace, {root, base}: {root: PortablePath, base: string}) {
  const {code, stdout} = await execUtils.execvp(`git`, [`show`, `${base}:${npath.fromPortablePath(ppath.relative(root, ppath.join(workspace.cwd, `package.json` as Filename)))}`], {cwd: workspace.cwd});

  if (code === 0) {
    return getNonce(Manifest.fromText(stdout));
  } else {
    return null;
  }
}

function getNonce(manifest: Manifest) {
  if (manifest.raw.nextVersion && (typeof manifest.raw.nextVersion.nonce === `string` || typeof manifest.raw.nextVersion.nonce === `number`)) {
    return String(manifest.raw.nextVersion.nonce);
  } else {
    return null;
  }
}

function willBeReleased(manifest: Manifest) {
  if (manifest.raw.nextVersion && typeof manifest.raw.nextVersion.semver === `string` && manifest.raw.nextVersion !== manifest.raw.version) {
    return true;
  } else {
    return false;
  }
}
