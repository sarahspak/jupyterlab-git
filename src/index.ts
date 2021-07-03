import {
  ILabShell,
  ILayoutRestorer,
  JupyterFrontEnd,
  IConnectionLost,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { Dialog, showErrorMessage, Toolbar } from '@jupyterlab/apputils';
import { IChangedArgs } from '@jupyterlab/coreutils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { FileBrowserModel, IFileBrowserFactory } from '@jupyterlab/filebrowser';
import { IMainMenu } from '@jupyterlab/mainmenu';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { IStatusBar } from '@jupyterlab/statusbar';
import { ITranslator, nullTranslator } from '@jupyterlab/translation';
import { INotebookTracker } from '@jupyterlab/notebook';

import {
  addCommands,
  addFileBrowserContextMenu,
  createGitMenu
} from './commandsAndMenu';
import { createNotebookDiff } from './components/diff/NotebookDiff';
import { addStatusBarWidget } from './components/StatusWidget';
import { GitExtension } from './model';
import { getServerSettings } from './server';
import { gitIcon } from './style/icons';
import { Git, IGitExtension } from './tokens';
import { addCloneButton } from './widgets/gitClone';
import { GitWidget } from './widgets/GitWidget';
// import { GitPanel } from './components/GitPanel';

export { NotebookDiff } from './components/diff/NotebookDiff';
export { PlainTextDiff } from './components/diff/PlainTextDiff';
export { DiffModel } from './components/diff/model';
export { Git, IGitExtension } from './tokens';

/**
 * The default running sessions extension.
 */
const plugin: JupyterFrontEndPlugin<IGitExtension> = {
  id: '@jupyterlab/git:plugin',
  requires: [
    IMainMenu,
    ILayoutRestorer,
    IFileBrowserFactory,
    IRenderMimeRegistry,
    ISettingRegistry,
    IDocumentManager,
    IStatusBar,
    ILabShell,
    INotebookTracker,
    IConnectionLost,
    ITranslator
  ],
  provides: IGitExtension,
  activate,
  autoStart: true
};

/**
 * Export the plugin as default.
 */
export default plugin;

/**
 * Activate the running plugin.
 */
async function activate(
  app: JupyterFrontEnd,
  mainMenu: IMainMenu,
  restorer: ILayoutRestorer,
  factory: IFileBrowserFactory,
  renderMime: IRenderMimeRegistry,
  settingRegistry: ISettingRegistry,
  docManager: IDocumentManager,
  statusBar: IStatusBar,
  labShell: ILabShell,
  notebookTracker: INotebookTracker,
  connectionLost: IConnectionLost | null,
  translator?: ITranslator
): Promise<IGitExtension> {
  let gitExtension: GitExtension | null = null;
  let settings: ISettingRegistry.ISettings;
  let serverSettings: Git.IServerSettings;
  let docmanager: IDocumentManager;
  // Get a reference to the default file browser extension
  const filebrowser = factory.defaultBrowser;
  translator = translator || nullTranslator;
  const trans = translator.load('jupyterlab-git');

  // Attempt to load application settings
  try {
    settings = await settingRegistry.load(plugin.id);
  } catch (error) {
    console.error(`Failed to load settings for the Git Extension.\n${error}`);
  }
  try {
    serverSettings = await getServerSettings(trans);
    const { frontendVersion, gitVersion, serverVersion } = serverSettings;
    // Version validation
    if (!gitVersion) {
      throw new Error(
        trans.__(
          'git command not found - please ensure you have Git > 2 installed'
        )
      );
    } else {
      const gitVersion_ = gitVersion.split('.');
      if (Number.parseInt(gitVersion_[0]) < 2) {
        throw new Error(
          trans.__('git command version must be > 2; got %1.', gitVersion)
        );
      }
    }

    if (frontendVersion && frontendVersion !== serverVersion) {
      throw new Error(
        trans.__(
          'The versions of the JupyterLab Git server frontend and backend do not match. ' +
            'The @jupyterlab/git frontend extension has version: %1 ' +
            'while the python package has version %2. ' +
            'Please install identical version of jupyterlab-git Python package and the @jupyterlab/git extension. Try running: pip install --upgrade jupyterlab-git',
          frontendVersion,
          serverVersion
        )
      );
    }
  } catch (error) {
    // If we fall here, nothing will be loaded in the frontend.
    console.error(
      'Failed to load the jupyterlab-git server extension settings',
      error
    );
    showErrorMessage(
      trans.__('Failed to load the jupyterlab-git server extension'),
      error.message,
      [Dialog.warnButton({ label: trans.__('DISMISS') })]
    );
    return null;
  }
  // Create the Git model
  gitExtension = new GitExtension(
    serverSettings.serverRoot,
    docmanager,
    app.docRegistry,
    settings
  );

  const serverRoot = serverSettings.serverRoot;

  // Whenever we restore the application, sync the Git extension path
  Promise.all([app.restored, filebrowser.model.restored]).then(() => {
    gitExtension.pathRepository = filebrowser.model.path;
  });

  // Whenever the file browser path changes, sync the Git extension path
  filebrowser.model.pathChanged.connect(
    (model: FileBrowserModel, change: IChangedArgs<string>) => {
      gitExtension.pathRepository = change.newValue;
    }
  );
  // Whenever a user adds/renames/saves/deletes/modifies a file within the lab environment, refresh the Git status
  app.serviceManager.contents.fileChanged.connect(() =>
    gitExtension.refreshStatus()
  );

  // Provided we were able to load application settings, create the extension widgets
  if (settings) {
    // Create the Git widget sidebar
    const gitPlugin = new GitWidget(
      gitExtension,
      settings,
      app.commands,
      factory.defaultBrowser.model,
      trans
    );
    gitPlugin.id = 'jp-git-sessions';
    gitPlugin.title.icon = gitIcon;
    gitPlugin.title.caption = 'Git';

    console.log(`is gitExtension.isready? ${gitExtension.isReady}`);
    console.log(
      `is gitExtension.refreshStandbyCondition ready? ${gitExtension.refreshStandbyCondition()}`
    );

    console.log(`is gitExtension.ready? ${gitExtension.ready}`);
    var today = new Date();
    var date =
      today.getFullYear() +
      '-' +
      (today.getMonth() + 1) +
      '-' +
      today.getDate() +
      ' ' +
      today.getHours() +
      ':' +
      today.getMinutes() +
      ':' +
      today.getSeconds() +
      ':' +
      today.getMilliseconds();
    console.log(`testing with ${date}`);

    // # guess and check a number of different conditions here
    // gitExtension.refreshBranch().then(() => {
    // gitExtension.refreshStatus().then(() => {
    // gitExtension.ready.then(() => {
    //   try {
    //     console.log('ready completed successfully');
    //     let currentBranchName = gitExtension.currentBranch.name;
    //     let currentBranchtopCommit = gitExtension.currentBranch.top_commit;
    //     console.log(currentBranchtopCommit);
    //     console.log(currentBranchName);
    //   } catch (error) {
    //     console.log(error);
    //     console.log('failed to get currentBranch name or top commit');
    //   }
    // });
    // try {
    //   gitExtension.refreshBranch();
    // } catch (error) {
    //   console.log(error);
    //   console.log('using gitExtension refreshBranch failed');
    // }

    // if (gitExtension.currentBranch) {
    //   console.log(gitExtension.currentBranch.name);
    // } else {
    //   console.log("branch name master since we couldn't find a name");
    // }
    // console.log(
    //   `is gitExtension.refreshStatus? ${gitExtension.currentBranch.name}`
    // );

    // const { branches, currentBranch, pathRepository } = gitExtension;
    // console.log(`branches are ${branches}`);
    // console.log(`currentBranch are ${currentBranch}`);
    // console.log(`pathRepository are ${pathRepository}`);

    // Add JupyterLab commands
    addCommands(
      app,
      gitExtension,
      filebrowser,
      settings,
      notebookTracker,
      connectionLost,
      serverRoot,
      trans
    );

    // Let the application restorer track the running panel for restoration of
    // application state (e.g. setting the running panel as the current side bar
    // widget).
    restorer.add(gitPlugin, 'git-sessions');

    // Rank has been chosen somewhat arbitrarily to give priority to the running
    // sessions widget in the sidebar.
    app.shell.add(gitPlugin, 'left', { rank: 200 });

    // Add a menu for the plugin
    mainMenu.addMenu(createGitMenu(app.commands, trans), { rank: 60 });

    // Add a clone button to the file browser extension toolbar
    addCloneButton(gitExtension, factory.defaultBrowser, app.commands);

    // Add the status bar widget
    addStatusBarWidget(statusBar, gitExtension, settings, trans);

    // Add the context menu items for the default file browser
    addFileBrowserContextMenu(
      gitExtension,
      factory.tracker,
      app.commands,
      app.contextMenu
    );

    // *********
    // guess n chek to find list of all files
    // const widget = factory.tracker.currentWidget;
    // if (!widget) {
    //   [];
    // }
    // let items = toArray(widget.selectedItems());
  }

  // Register diff providers
  gitExtension.registerDiffProvider(
    'Nbdime',
    ['.ipynb'],
    (model: Git.Diff.IModel<string>, toolbar?: Toolbar) =>
      createNotebookDiff(model, renderMime, toolbar)
  );

  return gitExtension;
}
