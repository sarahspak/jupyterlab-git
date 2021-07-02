import {
  JupyterFrontEnd,
  ConnectionLost,
  IConnectionLost
} from '@jupyterlab/application';
import {
  NotebookActions,
  NotebookPanel,
  NotebookTrustStatus
} from '@jupyterlab/notebook';
// import {
// KernelManager,
// KernelSpecManager,
// KernelMessage,
// SessionManager,
//   ServerConnection,
//   ServiceManager
//  } from '@jupyterlab/services';
// import { SessionContext } from '@jupyterlab/apputils';
import { ICodeCellModel } from '@jupyterlab/cells';
import {
  Dialog,
  InputDialog,
  MainAreaWidget,
  showDialog,
  showErrorMessage,
  Toolbar,
  ToolbarButton,
  WidgetTracker
} from '@jupyterlab/apputils';

// import { IDocumentManager } from '@jupyterlab/docmanager';
import { PathExt } from '@jupyterlab/coreutils';
import { FileBrowser } from '@jupyterlab/filebrowser';
import { Contents } from '@jupyterlab/services';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { ITerminal } from '@jupyterlab/terminal';
import {
  TranslationBundle
  // TranslationManager, ITranslator
} from '@jupyterlab/translation';
import { closeIcon, ContextMenuSvg } from '@jupyterlab/ui-components';
import { ArrayExt, toArray } from '@lumino/algorithm';
import { CommandRegistry } from '@lumino/commands';
import { PromiseDelegate } from '@lumino/coreutils';
import { Message } from '@lumino/messaging';
import { Menu, Panel } from '@lumino/widgets';
import { INotebookTracker, INotebookModel } from '@jupyterlab/notebook';
import * as React from 'react';
import { DiffModel } from './components/diff/model';
import { createPlainTextDiff } from './components/diff/PlainTextDiff';
import { CONTEXT_COMMANDS } from './components/FileList';
import { AUTH_ERROR_MESSAGES, requestAPI } from './git';
import { logger } from './logger';
import { getDiffProvider, GitExtension } from './model';
import {
  addIcon,
  diffIcon,
  discardIcon,
  gitIcon,
  openIcon,
  removeIcon
} from './style/icons';
import {
  CommandIDs,
  ContextCommandIDs,
  Git,
  IGitExtension,
  Level
} from './tokens';
import { GitCredentialsForm } from './widgets/CredentialsBox';
import { GitCloneForm } from './widgets/GitCloneForm';
import { DocumentRegistry } from '@jupyterlab/docregistry';

interface IGitCloneArgs {
  /**
   * Path in which to clone the Git repository
   */
  path: string;
  /**
   * Git repository url
   */
  url: string;
}

/**
 * Git operations requiring authentication
 */
enum Operation {
  Clone = 'Clone',
  Pull = 'Pull',
  Push = 'Push',
  ShowDialog = 'Show',
  GetCurrentFile = 'GetCurrFile',
  TC4ML = 'tc4ml',
  RunMultipleCommands = 'RunMultCommands'
}

interface IFileDiffArgument {
  context?: Git.Diff.IContext;
  filePath: string;
  isText: boolean;
  status?: Git.Status;
}

export namespace CommandArguments {
  export interface IGitFileDiff {
    files: IFileDiffArgument[];
  }
  export interface IGitContextAction {
    files: Git.IStatusFile[];
  }
}

function pluralizedContextLabel(singular: string, plural: string) {
  return (args: any) => {
    const { files } = args as any as CommandArguments.IGitContextAction;
    if (files.length > 1) {
      return plural;
    } else {
      return singular;
    }
  };
}

/**
 * Add the commands for the git extension.
 */
export function addCommands(
  app: JupyterFrontEnd,
  gitModel: GitExtension,
  fileBrowser: FileBrowser,
  settings: ISettingRegistry.ISettings,
  notebookTracker: INotebookTracker,
  connectionLost: IConnectionLost | null,
  serverRoot: string,
  trans: TranslationBundle
): void {
  const { commands, shell } = app;

  /**
   * Commit using a keystroke combination when in CommitBox.
   *
   * This command is not accessible from the user interface (not visible),
   * as it is handled by a signal listener in the CommitBox component instead.
   * The label and caption are given to ensure that the command will
   * show up in the shortcut editor UI with a nice description.
   */
  commands.addCommand(CommandIDs.gitSubmitCommand, {
    label: trans.__('Commit from the Commit Box'),
    caption: trans.__(
      'Submit the commit using the summary and description from commit box'
    ),
    execute: () => void 0,
    isVisible: () => false
  });

  /**
   * Add open terminal in the Git repository
   */
  commands.addCommand(CommandIDs.gitTerminalCommand, {
    label: trans.__('Open Git Repository in Terminal'),
    caption: trans.__('Open a New Terminal to the Git Repository'),
    execute: async args => {
      const main = (await commands.execute(
        'terminal:create-new',
        args
      )) as MainAreaWidget<ITerminal.ITerminal>;

      try {
        if (gitModel.pathRepository !== null) {
          const terminal = main.content;
          terminal.session.send({
            type: 'stdin',
            content: [
              `cd "${gitModel.pathRepository.split('"').join('\\"')}"\n`
            ]
          });
        }

        return main;
      } catch (e) {
        console.error(e);
        main.dispose();
      }
    },
    isEnabled: () =>
      gitModel.pathRepository !== null &&
      app.serviceManager.terminals.isAvailable()
  });

  /** Add open/go to git interface command */
  commands.addCommand(CommandIDs.gitUI, {
    label: trans.__('Git Interface'),
    caption: trans.__('Go to Git user interface'),
    execute: () => {
      try {
        shell.activateById('jp-git-sessions');
      } catch (err) {
        console.error('Fail to open Git tab.');
      }
    }
  });

  /** Add git init command */
  commands.addCommand(CommandIDs.gitInit, {
    label: trans.__('Initialize a Repository'),
    caption: trans.__(
      'Create an empty Git repository or reinitialize an existing one'
    ),
    execute: async () => {
      const currentPath = fileBrowser.model.path;
      const result = await showDialog({
        title: trans.__('Initialize a Repository'),
        body: trans.__('Do you really want to make this directory a Git Repo?'),
        buttons: [
          Dialog.cancelButton({ label: trans.__('Cancel') }),
          Dialog.warnButton({ label: trans.__('Yes') })
        ]
      });

      if (result.button.accept) {
        logger.log({
          message: trans.__('Initializing...'),
          level: Level.RUNNING
        });
        try {
          await gitModel.init(currentPath);
          gitModel.pathRepository = currentPath;
          logger.log({
            message: trans.__('Git repository initialized.'),
            level: Level.SUCCESS
          });
        } catch (error) {
          console.error(
            trans.__(
              'Encountered an error when initializing the repository. Error: '
            ),
            error
          );
          logger.log({
            message: trans.__('Failed to initialize the Git repository'),
            level: Level.ERROR,
            error
          });
        }
      }
    },
    isEnabled: () => gitModel.pathRepository === null
  });

  /** Open URL externally */
  commands.addCommand(CommandIDs.gitOpenUrl, {
    label: args => args['text'] as string,
    execute: args => {
      const url = args['url'] as string;
      window.open(url);
    }
  });

  /** add toggle for simple staging */
  commands.addCommand(CommandIDs.gitToggleSimpleStaging, {
    label: trans.__('Simple staging'),
    isToggled: () => !!settings.composite['simpleStaging'],
    execute: args => {
      settings.set('simpleStaging', !settings.composite['simpleStaging']);
    }
  });

  /** add toggle for double click opens diffs */
  commands.addCommand(CommandIDs.gitToggleDoubleClickDiff, {
    label: trans.__('Double click opens diff'),
    isToggled: () => !!settings.composite['doubleClickDiff'],
    execute: args => {
      settings.set('doubleClickDiff', !settings.composite['doubleClickDiff']);
    }
  });

  /** Command to add a remote Git repository */
  commands.addCommand(CommandIDs.gitAddRemote, {
    label: trans.__('Add Remote Repository'),
    caption: trans.__('Add a Git remote repository'),
    isEnabled: () => gitModel.pathRepository !== null,
    execute: async args => {
      if (gitModel.pathRepository === null) {
        console.warn(
          trans.__('Not in a Git repository. Unable to add a remote.')
        );
        return;
      }
      let url = args['url'] as string;
      const name = args['name'] as string;

      if (!url) {
        const result = await InputDialog.getText({
          title: trans.__('Add a remote repository'),
          placeholder: trans.__('Remote Git repository URL')
        });

        if (result.button.accept) {
          url = result.value;
        }
      }

      if (url) {
        try {
          await gitModel.addRemote(url, name);
        } catch (error) {
          console.error(error);
          showErrorMessage(
            trans.__('Error when adding remote repository'),
            error
          );
        }
      }
    }
  });

  /** Add git clone command */
  commands.addCommand(CommandIDs.gitClone, {
    label: trans.__('Clone a Repository'),
    caption: trans.__('Clone a repository from a URL'),
    isEnabled: () => gitModel.pathRepository === null,
    execute: async () => {
      const result = await showDialog({
        title: trans.__('Clone a repo'),
        body: new GitCloneForm(trans),
        focusNodeSelector: 'input',
        buttons: [
          Dialog.cancelButton({ label: trans.__('Cancel') }),
          Dialog.okButton({ label: trans.__('CLONE') })
        ]
      });

      if (result.button.accept && result.value) {
        logger.log({
          level: Level.RUNNING,
          message: trans.__('Cloning...')
        });
        try {
          const details = await Private.showGitOperationDialog<IGitCloneArgs>(
            gitModel,
            Operation.Clone,
            trans,
            { path: fileBrowser.model.path, url: result.value }
          );
          logger.log({
            message: trans.__('Successfully cloned'),
            level: Level.SUCCESS,
            details
          });
          await fileBrowser.model.refresh();
        } catch (error) {
          console.error(
            'Encountered an error when cloning the repository. Error: ',
            error
          );
          logger.log({
            message: trans.__('Failed to clone'),
            level: Level.ERROR,
            error
          });
        }
      }
    }
  });

  /** Add git open gitignore command */
  commands.addCommand(CommandIDs.gitOpenGitignore, {
    label: trans.__('Open .gitignore'),
    caption: trans.__('Open .gitignore'),
    isEnabled: () => gitModel.pathRepository !== null,
    execute: async () => {
      await gitModel.ensureGitignore();
    }
  });

  /** Add git push command */
  commands.addCommand(CommandIDs.gitPush, {
    label: trans.__('Push to Remote'),
    caption: trans.__('Push code to remote repository'),
    isEnabled: () => gitModel.pathRepository !== null,
    execute: async () => {
      logger.log({
        level: Level.RUNNING,
        message: trans.__('Pushing...')
      });
      try {
        const details = await Private.showGitOperationDialog(
          gitModel,
          Operation.Push,
          trans
        );
        console.log(details);
        console.log('details printed above ');
        logger.log({
          message: trans.__('Successfully pushed'),
          level: Level.SUCCESS,
          details
        });
      } catch (error) {
        console.error(
          trans.__('Encountered an error when pushing changes. Error: '),
          error
        );
        logger.log({
          message: trans.__('Failed to push'),
          level: Level.ERROR,
          error
        });
      }
    }
  });

  /** Add git pull command */
  commands.addCommand(CommandIDs.gitPull, {
    label: trans.__('Pull from Remote'),
    caption: trans.__('Pull latest code from remote repository'),
    isEnabled: () => gitModel.pathRepository !== null,
    execute: async () => {
      logger.log({
        level: Level.RUNNING,
        message: trans.__('Pulling...')
      });
      try {
        const details = await Private.showGitOperationDialog(
          gitModel,
          Operation.Pull,
          trans
        );
        logger.log({
          message: trans.__('Successfully pulled'),
          level: Level.SUCCESS,
          details
        });
      } catch (error) {
        console.error(
          'Encountered an error when pulling changes. Error: ',
          error
        );
        logger.log({
          message: trans.__('Failed to pull'),
          level: Level.ERROR,
          error
        });
      }
    }
  });

  commands.addCommand(CommandIDs.getCellMetadata, {
    label: trans.__('Get cell metadata of currently open notebook'),
    caption: trans.__('Get cell metadata of currently open notebook'),
    execute: async () => {
      const results = await Private.getCellMetadata();
      console.log(results);
    }
  });

  commands.addCommand(CommandIDs.saveNotebook, {
    label: trans.__('Create shareable link for TC4ML documentation'),
    caption: trans.__(
      'Save, commit, and push currently open notebook to GHE. Get a shareable link back'
    ),
    isEnabled: () => gitModel.pathRepository !== null,
    execute: async () => {
      const current = Private.getCurrent(notebookTracker, shell);
      const current_file_name = current.context.path;
      const repoPath = gitModel.pathRepository;
      const fullFileName = repoPath.concat('/').concat(current_file_name);

      // STEP 1 - restart all and save
      await commands.execute('runmenu:restart-and-run-all').then(() => {
        console.log(
          'the restart and run all command has completed, but believe cells are still running'
        );
      });

      console.log(
        'does this show up before the restart and run all command console log has completed?'
      );
      while (!Private.checkKernelConnection(connectionLost, app)) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      if (Private.checkKernelConnection(connectionLost, app)) {
        console.log('wow, the kernel is connected again!');
      }
      // need to enter a pause?
      // TODO
      // to do - need some kind of check to ensure nothing is running in any cells
      const result = await showDialog({
        title: 'Restart complete',
        body: 'Do you wish to push this notebook to GHE?',
        buttons: [
          Dialog.cancelButton({ label: trans.__('Cancel') }),
          Dialog.okButton({ label: trans.__('Yes') })
        ]
      });

      if (result.button.accept) {
        // STEP 2 - USE WIDGET TO SAVE
        logger.log({
          level: Level.RUNNING,
          message: trans.__('Getting notebook ready for GHE...')
        });
        try {
          while (!notebookTracker.currentWidget)
            await new Promise(resolve => setTimeout(resolve, 1000));

          const context = notebookTracker.currentWidget.context;
          const item = new NotebookTrustStatus();
          // Keep the status item up-to-date with the current notebook.
          notebookTracker.currentChanged.connect(() => {
            const current = notebookTracker.currentWidget;
            item.model.notebook = current && current.content;
          });

          await Private.saveNb(
            gitModel,
            fullFileName,
            current_file_name,
            commands,
            context
          );
          logger.log({
            level: Level.SUCCESS,
            message: 'Complete!'
          });
        } catch (error) {
          console.error(
            'Encountered an error when trying to save. Error: ',
            error
          );
          logger.log({
            message: trans.__('Failed to save'),
            level: Level.ERROR,
            error
          });
        }
      } else {
        console.log('canceled the saving');
        return;
      }

      // step 4 - commit
      logger.log({
        level: Level.RUNNING,
        message: trans.__('starting git commit...')
      });
      const tryCommit = await Private.gitCommit(gitModel);
      if (!tryCommit) {
        console.log('something went wrong w/ the commit');
        logger.log({
          level: Level.ERROR,
          message: 'Commit failed'
        });
        return;
      } else {
        console.log('we successfully committed!');
        logger.log({
          level: Level.SUCCESS,
          message: 'Commit is complete'
        });
      }

      // step 5 - push
      console.log('can we even do this git push thing?');
      logger.log({
        level: Level.RUNNING,
        message: trans.__('starting git push...')
      });
      const currBranchName = await Private.getCurrBranchName(gitModel).then(
        result => result.current_branch
      );
      void showDialog({
        title: 'Git Push',
        body: (
          <span>
            {'About to push this notebook to the branch below'}
            {current.context.path}
            {currBranchName}
          </span>
        ),
        buttons: [
          Dialog.cancelButton({ label: trans.__('Cancel') }),
          Dialog.okButton({ label: trans.__('Yes') })
        ]
      })
        .then(async result => {
          if (result.button.accept) {
            console.log('starting git push');
            try {
              await commands.execute('git:push').then(() => {
                console.log('we successfully pushed!');
                logger.log({
                  level: Level.SUCCESS,
                  message: 'Git push is complete'
                });
              });
            } catch (error) {
              console.log('error in our git push command');
              logger.log({
                level: Level.ERROR,
                message: 'Git push failed',
                error
              });
              return;
            }
          } else {
            console.log('something went wrong w/ the commit');
            logger.log({
              level: Level.ERROR,
              message: 'Commit failed'
            });
          }
        })
        .then(() => {
          // step 6 get commit link
          try {
            Private.gitGetWebURL(gitModel, current_file_name).then(result => {
              console.log(`successfully got weburl ${result.url}`);
            });
          } catch (error) {
            logger.log({
              level: Level.ERROR,
              message: 'error in getting gitWebURL',
              error
            });
          }
        });
    }
  });

  // ************************************************************************
  //  start here
  // ************************************************************************
  commands.addCommand(CommandIDs.runMultipleCommands, {
    label: 'Run multiple commands',
    execute: async args => {
      const commandsString: string[] = args.commands as string[];
      for (let i = 0; i < commandsString.length; i++) {
        const cmd = commandsString[i];
        await app.commands.execute(cmd);
      }
      console.log(`Commands ${commandsString} have completed.`);
    }
  });
  commands.addCommand(CommandIDs.gitAdd, {
    label: trans.__('Git Add with some neat diff stuff'),
    caption: trans.__('git add'),
    isEnabled: () => gitModel.pathRepository !== null,
    execute: async () => {
      logger.log({
        level: Level.RUNNING,
        message: trans.__('starting my own git add...')
      });
      const current = Private.getCurrent(notebookTracker, shell);
      const current_file_name = current.context.path;
      // const repoPath = gitModel.pathRepository;
      // const fullFileName = repoPath.concat('/').concat(current_file_name);

      /// plan of attack: first we git add the current file,
      // then we git add all deleted files, so that git will detect that we've renamed the file
      // then we git push
      try {
        await Private.gitAddWithBranching(gitModel, current_file_name)
          .then(() => {
            // check to see if we can see if a file has been renamed after we add this current file
            gitModel.get_changed_files().then(result => {
              console.log('this is changesWORKINGvsHead');
              console.log(result[0].files);
              console.log('this is changesINDEXvsHead');
              console.log(result[1].files);
            });
          })
          .then(() => gitModel.getAllDeletedFiles());
      } catch (error) {
        throw error;
      }
    }
  });

  commands.addCommand(CommandIDs.tc4ml, {
    label: trans.__('restart-run-all+save'),
    caption: trans.__('tc4ml test'),
    isEnabled: () => gitModel.pathRepository !== null,
    execute: async args => {
      logger.log({
        level: Level.RUNNING,
        message: trans.__('going to run tc4ml steps...')
      });

      // step 1: run restart-kernel and run all
      const restart = await commands.execute('runmenu:restart-and-run-all');
      if (restart) {
        console.log(restart);
        console.log('restart');
      } else {
        return;
      }
      // constantly check the kernel connection status
      // also constantly check that all cells in the notebook have an executionCount
      var attempts = 10;
      for (let i = 0; i < attempts; i++) {
        while (!Private.checkKernelConnection(connectionLost, app)) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }

      if (Private.checkKernelConnection(connectionLost, app)) {
        console.log('wow the kernel is connected again!');
        logger.log({
          level: Level.SUCCESS,
          message: trans.__('succesfully restarted and ran kernel...')
        });
        return;
      }

      // step 2: save notebook
      console.log('starting step 2 - saving notebook!');
      // const saveNotebook: Promise<any> = await commands.execute('git:saveNotebook');
      console.log('starting git save notebook');
      await commands.execute('git:saveNotebook');

      console.log('context being defined again');
      const context = notebookTracker.currentWidget.context;
      while (!notebookTracker.currentWidget)
        await new Promise(resolve => setTimeout(resolve, 1000));
      console.log('ok, notebooktracker.currentWidget exists and is defined');

      const notebookName = representFilesEasy(
        notebookTracker.currentWidget.title.label
      );
      const result = await showDialog({
        title: 'Save current notebook',
        body: (
          <span>
            {trans.__('Would you like to save the following file or files?')}
            {notebookName}
          </span>
        ),
        buttons: [
          Dialog.cancelButton({ label: trans.__('Cancel') }),
          Dialog.okButton({ label: trans.__('Save') })
        ]
      });
      if (result.button.accept) {
        logger.log({
          level: Level.RUNNING,
          message: trans.__('Saving current notebook...')
        });
        try {
          if (!context.model.dirty) {
            logger.log({
              level: Level.SUCCESS,
              message: trans.__('succesfully saved current notebook...')
            });
            return;
          }
          return;
        } catch (error) {
          console.error(error);
          logger.log({
            level: Level.ERROR,
            message: trans.__(`error in saving current notebook ${error}`),
            error
          });
        }
      } else {
        logger.log({
          level: Level.ERROR,
          message: trans.__('Failed to save notebook - dialog crashed...')
        });
      }
    }
  });

  // step 3: save

  /** Add test SHOW MENU COMMAND */
  commands.addCommand(CommandIDs.gitShowDialog, {
    label: trans.__('Show Git Dialog Test'),
    caption: trans.__('Git dialog test'),
    isEnabled: () => gitModel.pathRepository !== null,
    execute: async () => {
      logger.log({
        level: Level.RUNNING,
        message: trans.__('Showing git dialog...')
      });
      try {
        const details = await Private.showGitDialog(
          gitModel,
          Operation.ShowDialog,
          trans,
          'Select the files you want to commit',
          [Dialog.okButton({ label: 'Okay' }), Dialog.cancelButton()]
        );
        logger.log({
          message: trans.__('Successfully showed dialog!!!'),
          level: Level.SUCCESS,
          details
        });
      } catch (error) {
        console.error(
          'Encountered an error when showing dialog. Error: ',
          error
        );
        logger.log({
          message: trans.__('Failed to show dialog'),
          level: Level.ERROR,
          error
        });
      }
    }
  });

  /** Add test TO ONLY SHOW CURRENT FILE` */
  commands.addCommand(CommandIDs.gitGetAllFiles, {
    label: trans.__('Git get current file test'),
    caption: trans.__('Git current file test'),
    isEnabled: () => gitModel.pathRepository !== null,
    execute: async () => {
      logger.log({
        level: Level.RUNNING,
        message: trans.__('Showing git current menu dialog...')
      });
      try {
        console.log(`You just clicked on the Show Me The Current File Dialog`);

        console.log('this is the sessionContext of notebook');
        console.log(notebookTracker.currentWidget.sessionContext);
        console.log('this is the context of notebook');
        console.log(notebookTracker.currentWidget.context);
        const details = await Private.gitGetAllFiles(
          gitModel,
          Operation.GetCurrentFile,
          trans,
          'Is this your current file?',
          [Dialog.okButton({ label: 'Okay' }), Dialog.cancelButton()],
          notebookTracker
        );
        logger.log({
          message: trans.__('Successfully showed dialog!!!'),
          level: Level.SUCCESS,
          details
        });
      } catch (error) {
        console.error(
          'Encountered an error when showing dialog. Error: ',
          error
        );
        logger.log({
          message: trans.__('Failed to show dialog'),
          level: Level.ERROR,
          error
        });
      }
    }
  });

  /**
   * Git display diff command - internal command
   *
   * @params model {Git.Diff.IModel<string>}: The diff model to display
   * @params isText {boolean}: Optional, whether the content is a plain text
   * @returns the main area widget or null
   */
  commands.addCommand(CommandIDs.gitShowDiff, {
    label: trans.__('Show Diff'),
    caption: trans.__('Display a file diff.'),
    execute: async args => {
      const { model, isText } = args as any as {
        model: Git.Diff.IModel<string>;
        isText?: boolean;
      };

      const buildDiffWidget =
        getDiffProvider(model.filename) ?? (isText && createPlainTextDiff);

      if (buildDiffWidget) {
        const id = `diff-${model.filename}-${model.reference.label}-${model.challenger.label}`;
        const mainAreaItems = shell.widgets('main');
        let mainAreaItem = mainAreaItems.next();
        while (mainAreaItem) {
          if (mainAreaItem.id === id) {
            shell.activateById(id);
            break;
          }
          mainAreaItem = mainAreaItems.next();
        }

        if (!mainAreaItem) {
          const content = new Panel();
          const modelIsLoading = new PromiseDelegate<void>();
          const diffWidget = (mainAreaItem = new MainAreaWidget<Panel>({
            content,
            reveal: modelIsLoading.promise
          }));
          diffWidget.id = id;
          diffWidget.title.label = PathExt.basename(model.filename);
          diffWidget.title.caption = model.filename;
          diffWidget.title.icon = diffIcon;
          diffWidget.title.closable = true;
          diffWidget.addClass('jp-git-diff-parent-widget');

          shell.add(diffWidget, 'main');
          shell.activateById(diffWidget.id);

          // Create the diff widget
          try {
            const widget = await buildDiffWidget(model, diffWidget.toolbar);

            diffWidget.toolbar.addItem('spacer', Toolbar.createSpacerItem());

            const refreshButton = new ToolbarButton({
              label: trans.__('Refresh'),
              onClick: async () => {
                await widget.refresh();
                refreshButton.hide();
              },
              tooltip: trans.__('Refresh diff widget'),
              className: 'jp-git-diff-refresh'
            });
            refreshButton.hide();
            diffWidget.toolbar.addItem('refresh', refreshButton);

            model.changed.connect(() => {
              refreshButton.show();
            });

            // Load the diff widget
            modelIsLoading.resolve();
            content.addWidget(widget);
          } catch (reason) {
            console.error(reason);
            const msg = `Load Diff Model Error (${reason.message || reason})`;
            modelIsLoading.reject(msg);
          }
        }

        return mainAreaItem;
      } else {
        await showErrorMessage(
          trans.__('Diff Not Supported'),
          trans.__(
            'Diff is not supported for %1 files.',
            PathExt.extname(model.filename).toLocaleLowerCase()
          )
        );

        return null;
      }
    },
    icon: diffIcon.bindprops({ stylesheet: 'menuItem' })
  });

  /* Context menu commands */
  commands.addCommand(ContextCommandIDs.gitFileOpen, {
    label: trans.__('Open'),
    caption: pluralizedContextLabel(
      trans.__('Open selected file'),
      trans.__('Open selected files')
    ),
    execute: async args => {
      const { files } = args as any as CommandArguments.IGitContextAction;
      for (const file of files) {
        const { x, y, to } = file;
        if (x === 'D' || y === 'D') {
          await showErrorMessage(
            trans.__('Open File Failed'),
            trans.__('This file has been deleted!')
          );
          return;
        }
        try {
          if (to[to.length - 1] !== '/') {
            commands.execute('docmanager:open', {
              path: gitModel.getRelativeFilePath(to)
            });
          } else {
            console.log('Cannot open a folder here');
          }
        } catch (err) {
          console.error(`Fail to open ${to}.`);
        }
      }
    },
    icon: openIcon.bindprops({ stylesheet: 'menuItem' })
  });

  commands.addCommand(ContextCommandIDs.gitFileDiff, {
    label: trans.__('Diff'),
    caption: pluralizedContextLabel(
      trans.__('Diff selected file'),
      trans.__('Diff selected files')
    ),
    execute: async args => {
      const { files } = args as any as CommandArguments.IGitFileDiff;
      for (const file of files) {
        const { context, filePath, isText, status } = file;

        // nothing to compare to for untracked files
        if (status === 'untracked') {
          continue;
        }

        const repositoryPath = gitModel.getRelativeFilePath();
        const filename = PathExt.join(repositoryPath, filePath);

        let diffContext = context;
        if (!diffContext) {
          const specialRef =
            status === 'staged'
              ? Git.Diff.SpecialRef.INDEX
              : Git.Diff.SpecialRef.WORKING;
          diffContext = {
            currentRef: specialRef,
            previousRef: 'HEAD'
          };
        }

        const challengerRef = Git.Diff.SpecialRef[diffContext.currentRef as any]
          ? { special: Git.Diff.SpecialRef[diffContext.currentRef as any] }
          : { git: diffContext.currentRef };

        // Create the diff widget
        const model = new DiffModel<string>({
          challenger: {
            content: async () => {
              return requestAPI<Git.IDiffContent>('content', 'POST', {
                filename: filePath,
                reference: challengerRef,
                top_repo_path: repositoryPath
              }).then(data => data.content);
            },
            label:
              (Git.Diff.SpecialRef[diffContext.currentRef as any] as any) ||
              diffContext.currentRef,
            source: diffContext.currentRef,
            updateAt: Date.now()
          },
          filename,
          reference: {
            content: async () => {
              return requestAPI<Git.IDiffContent>('content', 'POST', {
                filename: filePath,
                reference: { git: diffContext.previousRef },
                top_repo_path: repositoryPath
              }).then(data => data.content);
            },
            label:
              (Git.Diff.SpecialRef[diffContext.previousRef as any] as any) ||
              diffContext.previousRef,
            source: diffContext.previousRef,
            updateAt: Date.now()
          }
        });

        const widget = await commands.execute(CommandIDs.gitShowDiff, {
          model,
          isText
        } as any);

        if (widget) {
          // Trigger diff model update
          if (diffContext.previousRef === 'HEAD') {
            gitModel.headChanged.connect(() => {
              model.reference = {
                ...model.reference,
                updateAt: Date.now()
              };
            });
          }
          // If the diff is on the current file and it is updated => diff model changed
          if (diffContext.currentRef === Git.Diff.SpecialRef.WORKING) {
            // More robust than fileBrowser.model.fileChanged
            app.serviceManager.contents.fileChanged.connect((_, change) => {
              const updateAt = new Date(
                change.newValue.last_modified
              ).valueOf();
              if (
                change.newValue.path === filename &&
                model.challenger.updateAt !== updateAt
              ) {
                model.challenger = {
                  ...model.challenger,
                  updateAt
                };
              }
            });
          }
        }
      }
    },
    icon: diffIcon.bindprops({ stylesheet: 'menuItem' })
  });

  commands.addCommand(ContextCommandIDs.gitFileAdd, {
    label: trans.__('Add'),
    caption: pluralizedContextLabel(
      trans.__('Stage or track the changes to selected file'),
      trans.__('Stage or track the changes of selected files')
    ),
    execute: async args => {
      const { files } = args as any as CommandArguments.IGitContextAction;
      for (const file of files) {
        await gitModel.add(file.to);
      }
    },
    icon: addIcon.bindprops({ stylesheet: 'menuItem' })
  });

  commands.addCommand(ContextCommandIDs.gitFileStage, {
    label: trans.__('Stage'),
    caption: pluralizedContextLabel(
      trans.__('Stage the changes of selected file'),
      trans.__('Stage the changes of selected files')
    ),
    execute: async args => {
      const { files } = args as any as CommandArguments.IGitContextAction;
      for (const file of files) {
        await gitModel.add(file.to);
      }
    },
    icon: addIcon.bindprops({ stylesheet: 'menuItem' })
  });

  commands.addCommand(ContextCommandIDs.gitFileTrack, {
    label: trans.__('Track'),
    caption: pluralizedContextLabel(
      trans.__('Start tracking selected file'),
      trans.__('Start tracking selected files')
    ),
    execute: async args => {
      const { files } = args as any as CommandArguments.IGitContextAction;
      for (const file of files) {
        await gitModel.add(file.to);
      }
    },
    icon: addIcon.bindprops({ stylesheet: 'menuItem' })
  });

  commands.addCommand(ContextCommandIDs.gitFileUnstage, {
    label: trans.__('Unstage'),
    caption: pluralizedContextLabel(
      trans.__('Unstage the changes of selected file'),
      trans.__('Unstage the changes of selected files')
    ),
    execute: async args => {
      const { files } = args as any as CommandArguments.IGitContextAction;
      for (const file of files) {
        if (file.x !== 'D') {
          await gitModel.reset(file.to);
        }
      }
    },
    icon: removeIcon.bindprops({ stylesheet: 'menuItem' })
  });

  function representFiles(files: Git.IStatusFile[]): JSX.Element {
    const elements = files.map(file => (
      <li key={file.to}>
        <b>{file.to}</b>
      </li>
    ));
    return <ul>{elements}</ul>;
  }

  function representFilesEasy(file: string): JSX.Element {
    const elements = <li>{file}</li>;
    return <ul>{elements}</ul>;
  }

  commands.addCommand(ContextCommandIDs.gitFileDelete, {
    label: trans.__('Delete'),
    caption: pluralizedContextLabel(
      trans.__('Delete this file'),
      trans.__('Delete these files')
    ),
    execute: async args => {
      const { files } = args as any as CommandArguments.IGitContextAction;
      const fileList = representFiles(files);

      const result = await showDialog({
        title: trans.__('Delete Files'),
        body: (
          <span>
            {trans.__(
              'Are you sure you want to permanently delete the following files? \
              This action cannot be undone.'
            )}
            {fileList}
          </span>
        ),
        buttons: [
          Dialog.cancelButton({ label: trans.__('Cancel') }),
          Dialog.warnButton({ label: trans.__('Delete') })
        ]
      });
      if (result.button.accept) {
        for (const file of files) {
          try {
            await app.commands.execute('docmanager:delete-file', {
              path: gitModel.getRelativeFilePath(file.to)
            });
          } catch (reason) {
            showErrorMessage(trans.__('Deleting %1 failed.', file.to), reason, [
              Dialog.warnButton({ label: trans.__('DISMISS') })
            ]);
          }
        }
      }
    },
    icon: closeIcon.bindprops({ stylesheet: 'menuItem' })
  });

  commands.addCommand(ContextCommandIDs.gitFileDiscard, {
    label: trans.__('Discard'),
    caption: pluralizedContextLabel(
      trans.__('Discard recent changes of selected file'),
      trans.__('Discard recent changes of selected files')
    ),
    execute: async args => {
      const { files } = args as any as CommandArguments.IGitContextAction;
      const fileList = representFiles(files);

      const result = await showDialog({
        title: trans.__('Discard changes'),
        body: (
          <span>
            {trans.__(
              'Are you sure you want to permanently discard changes to the following files? \
              This action cannot be undone.'
            )}
            {fileList}
          </span>
        ),
        buttons: [
          Dialog.cancelButton({ label: trans.__('Cancel') }),
          Dialog.warnButton({ label: trans.__('Discard') })
        ]
      });
      if (result.button.accept) {
        for (const file of files) {
          try {
            if (
              file.status === 'staged' ||
              file.status === 'partially-staged'
            ) {
              await gitModel.reset(file.to);
            }
            if (
              file.status === 'unstaged' ||
              (file.status === 'partially-staged' && file.x !== 'A')
            ) {
              // resetting an added file moves it to untracked category => checkout will fail
              await gitModel.checkout({ filename: file.to });
            }
          } catch (reason) {
            showErrorMessage(
              trans.__('Discard changes for %1 failed.', file.to),
              reason,
              [Dialog.warnButton({ label: trans.__('DISMISS') })]
            );
          }
        }
      }
    },
    icon: discardIcon.bindprops({ stylesheet: 'menuItem' })
  });

  commands.addCommand(ContextCommandIDs.gitIgnore, {
    label: pluralizedContextLabel(
      trans.__('Ignore this file (add to .gitignore)'),
      trans.__('Ignore these files (add to .gitignore)')
    ),
    caption: pluralizedContextLabel(
      trans.__('Ignore this file (add to .gitignore)'),
      trans.__('Ignore these files (add to .gitignore)')
    ),
    execute: async args => {
      const { files } = args as any as CommandArguments.IGitContextAction;
      for (const file of files) {
        if (file) {
          await gitModel.ignore(file.to, false);
        }
      }
    }
  });

  commands.addCommand(ContextCommandIDs.gitIgnoreExtension, {
    label: args => {
      const { files } = args as any as CommandArguments.IGitContextAction;
      const extensions = files
        .map(file => PathExt.extname(file.to))
        .filter(extension => extension.length > 0);
      return trans._n(
        'Ignore %2 extension (add to .gitignore)',
        'Ignore %2 extensions (add to .gitignore)',
        extensions.length,
        extensions.join(', ')
      );
    },
    caption: pluralizedContextLabel(
      trans.__('Ignore this file extension (add to .gitignore)'),
      trans.__('Ignore these files extension (add to .gitignore)')
    ),
    execute: async args => {
      const { files } = args as any as CommandArguments.IGitContextAction;
      for (const selectedFile of files) {
        if (selectedFile) {
          const extension = PathExt.extname(selectedFile.to);
          if (extension.length > 0) {
            const result = await showDialog({
              title: trans.__('Ignore file extension'),
              body: trans.__(
                'Are you sure you want to ignore all %1 files within this git repository?',
                extension
              ),
              buttons: [
                Dialog.cancelButton(),
                Dialog.okButton({ label: trans.__('Ignore') })
              ]
            });
            if (result.button.label === trans.__('Ignore')) {
              await gitModel.ignore(selectedFile.to, true);
            }
          }
        }
      }
    },
    isVisible: args => {
      const { files } = args as any as CommandArguments.IGitContextAction;
      return files.some(selectedFile => {
        const extension = PathExt.extname(selectedFile.to);
        return extension.length > 0;
      });
    }
  });

  commands.addCommand(ContextCommandIDs.gitNoAction, {
    label: trans.__('No actions available'),
    isEnabled: () => false,
    execute: () => void 0
  });
}

/**
 * Adds commands and menu items.
 *
 * @param commands - Jupyter App commands registry
 * @param trans - language translator
 * @returns menu
 */
export function createGitMenu(
  commands: CommandRegistry,
  trans: TranslationBundle
): Menu {
  const RESOURCES = [
    {
      text: trans.__('Set Up Remotes'),
      url: 'https://www.atlassian.com/git/tutorials/setting-up-a-repository'
    },
    {
      text: trans.__('Git Documentation'),
      url: 'https://git-scm.com/doc'
    }
  ];

  const menu = new Menu({ commands });
  menu.title.label = 'MLHome Tools';
  [
    // CommandIDs.gitPush,
    // CommandIDs.gitPull,
    // CommandIDs.gitShowDialog,
    // CommandIDs.gitGetAllFiles,
    CommandIDs.getCellMetadata
    // CommandIDs.tc4ml,
    // CommandIDs.saveNotebook
  ].forEach(command => {
    menu.addItem({ command });
  });

  menu.addItem({ type: 'separator' });

  menu.addItem({ command: CommandIDs.saveNotebook });

  // menu.addItem({
  //   command: CommandIDs.runMultipleCommands,
  //   args: {
  //     commands: [
  //       'runmenu:restart-and-run-all',
  //       // then, save my work
  //       'docmanager:save-as',
  //       // 'git:saveNotebook',
  //       'git:show-all-files'
  //       // git pick branch or make newone
  //       // git add
  //       // git commit
  //       // git push
  //       // git commit hash + link
  //     ]
  //   }
  // });

  menu.addItem({ type: 'separator' });

  const tutorial = new Menu({ commands });
  tutorial.title.label = trans.__(' Help ');
  RESOURCES.map(args => {
    tutorial.addItem({
      args,
      command: CommandIDs.gitOpenUrl
    });
  });

  menu.addItem({ type: 'submenu', submenu: tutorial });

  return menu;
}

// matches only non-directory items
const selectorNotDir = '.jp-DirListing-item[data-isdir="false"]';

export function addMenuItems(
  commands: ContextCommandIDs[],
  contextMenu: Menu,
  selectedFiles: Git.IStatusFile[]
): void {
  commands.forEach(command => {
    if (command === ContextCommandIDs.gitFileDiff) {
      contextMenu.addItem({
        command,
        args: {
          files: selectedFiles.map(file => {
            return {
              filePath: file.to,
              isText: !file.is_binary,
              status: file.status
            };
          })
        } as CommandArguments.IGitFileDiff as any
      });
    } else {
      contextMenu.addItem({
        command,
        args: {
          files: selectedFiles
        } as CommandArguments.IGitContextAction as any
      });
    }
  });
}

/**
 * Add Git context (sub)menu to the file browser context menu.
 */
export function addFileBrowserContextMenu(
  model: IGitExtension,
  tracker: WidgetTracker<FileBrowser>,
  commands: CommandRegistry,
  contextMenu: ContextMenuSvg
): void {
  function getSelectedBrowserItems(): Contents.IModel[] {
    const widget = tracker.currentWidget;
    if (!widget) {
      return [];
    }
    return toArray(widget.selectedItems());
  }

  class GitMenu extends Menu {
    private _commands: ContextCommandIDs[];
    private _paths: string[];

    protected onBeforeAttach(msg: Message) {
      // Render using the most recent model (even if possibly outdated)
      this.updateItems();
      const renderedStatus = model.status;

      // Trigger refresh before the menu is displayed
      model
        .refreshStatus()
        .then(() => {
          if (model.status !== renderedStatus) {
            // update items if needed
            this.updateItems();
          }
        })
        .catch(error => {
          console.error(
            'Fail to refresh model when displaying git context menu.',
            error
          );
        });
      super.onBeforeAttach(msg);
    }

    protected updateItems(): void {
      const wasShown = this.isVisible;
      const parent = this.parentMenu;

      const items = getSelectedBrowserItems();
      const statuses = new Set<Git.Status>(
        items
          .map(item => model.getFile(item.path)?.status)
          .filter(status => typeof status !== 'undefined')
      );

      // get commands and de-duplicate them
      const allCommands = new Set<ContextCommandIDs>(
        // flatten the list of lists of commands
        []
          .concat(...[...statuses].map(status => CONTEXT_COMMANDS[status]))
          // filter out the Open and Delete commands as
          // those are not needed in file browser
          .filter(
            command =>
              command !== ContextCommandIDs.gitFileOpen &&
              command !== ContextCommandIDs.gitFileDelete &&
              typeof command !== 'undefined'
          )
          // replace stage and track with a single "add" operation
          .map(command =>
            command === ContextCommandIDs.gitFileStage ||
            command === ContextCommandIDs.gitFileTrack
              ? ContextCommandIDs.gitFileAdd
              : command
          )
      );

      // if looking at a tracked file with no changes,
      // it has no status, nor any actions available
      // (although `git rm` would be a valid action)
      if (allCommands.size === 0 && statuses.size === 0) {
        allCommands.add(ContextCommandIDs.gitNoAction);
      }

      const commandsChanged =
        !this._commands ||
        this._commands.length !== allCommands.size ||
        !this._commands.every(command => allCommands.has(command));

      const paths = items.map(item => item.path);

      const filesChanged =
        !this._paths || !ArrayExt.shallowEqual(this._paths, paths);

      if (commandsChanged || filesChanged) {
        const commandsList = [...allCommands];
        this.clearItems();
        addMenuItems(
          commandsList,
          this,
          paths
            .map(path => model.getFile(path))
            // if file cannot be resolved (has no action available),
            // omit the undefined result
            .filter(file => typeof file !== 'undefined')
        );
        if (wasShown) {
          // show he menu again after downtime for refresh
          parent.triggerActiveItem();
        }
        this._commands = commandsList;
        this._paths = paths;
      }
    }

    onBeforeShow(msg: Message): void {
      super.onBeforeShow(msg);
    }
  }

  const gitMenu = new GitMenu({ commands });
  gitMenu.title.label = 'Git';
  gitMenu.title.icon = gitIcon.bindprops({ stylesheet: 'menuItem' });

  contextMenu.addItem({
    type: 'submenu',
    submenu: gitMenu,
    selector: selectorNotDir,
    rank: 5
  });
}

/* eslint-disable no-inner-declarations */
namespace Private {
  /**
   * Handle Git operation that may require authentication.
   *
   * @private
   * @param model - Git extension model
   * @param operation - Git operation name
   * @param trans - language translator
   * @param args - Git operation arguments
   * @param authentication - Git authentication information
   * @param retry - Is this operation retried?
   * @returns Promise for displaying a dialog
   */
  export async function showGitOperationDialog<T>(
    model: GitExtension,
    operation: Operation,
    trans: TranslationBundle,
    args?: T,
    authentication?: Git.IAuth,
    retry = false
  ): Promise<string> {
    try {
      let result: Git.IResultWithMessage;
      // the Git action
      switch (operation) {
        case Operation.Clone:
          // eslint-disable-next-line no-case-declarations
          const { path, url } = args as any as IGitCloneArgs;
          result = await model.clone(path, url, authentication);
          break;
        case Operation.Pull:
          result = await model.pull(authentication);
          break;
        case Operation.Push:
          result = await model.push(authentication);
          break;
        default:
          result = { code: -1, message: 'Unknown git command' };
          break;
      }

      return result.message;
    } catch (error) {
      if (
        AUTH_ERROR_MESSAGES.some(
          errorMessage => error.message.indexOf(errorMessage) > -1
        )
      ) {
        // If the error is an authentication error, ask the user credentials
        const credentials = await showDialog({
          title: trans.__('Git credentials required'),
          body: new GitCredentialsForm(
            trans,
            trans.__('Enter credentials for remote repository'),
            retry ? trans.__('Incorrect username or password.') : ''
          )
        });

        if (credentials.button.accept) {
          // Retry the operation if the user provides its credentials
          return await showGitOperationDialog<T>(
            model,
            operation,
            trans,
            args,
            credentials.value,
            true
          );
        }
      }
      // Throw the error if it cannot be handled or
      // if the user did not accept to provide its credentials
      throw error;
    }
  }
  /* eslint-enable no-inner-declarations */

  export async function TC4ML<T>(
    model: GitExtension,
    operation: Operation,
    trans: TranslationBundle,
    Title: string,
    Buttons: any,
    retry = false,
    args?: T,
    authentication?: Git.IAuth
  ): Promise<any> {}

  export async function gitGetAllFiles<T>(
    model: GitExtension,
    operation: Operation,
    trans: TranslationBundle,
    Title: string,
    Buttons: any,
    notebookTracker: INotebookTracker,
    retry = false,
    args?: T,
    authentication?: Git.IAuth
  ): Promise<any> {
    try {
      let result: Git.IResultWithMessage;
      let test_result: Git.IChangedFilesResult;
      // the Git action
      switch (operation) {
        case Operation.GetCurrentFile:
          console.log('did it break before?');
          test_result = await model.get_all_files(authentication);
          console.log('did it break after model.get_all_files??');
          break;
        default:
          result = { code: -1, message: 'Unknown command' };
          break;
      }
      if (result) {
        return result.message;
      } else {
        const file_information = model.status.files.map(f => {
          return { from_file: f.from, to_file: f.to, status_file: f.status };
        });
        console.log('printing file_information');
        console.log(file_information);
        console.log('printing model.status.files');
        console.log(model.status.files);
        // console.log("printing out labShell.currentWidget.title.label");
        // console.log(labShell.currentWidget.title.label);
        // #2
        // # this is to see if we can get the same value from using result
        const myDialogResult = await InputDialog.getText({
          title: 'This should only show us the file that we are currently on',
          placeholder: notebookTracker.currentWidget.title.label
        });

        const myListOfFiles = test_result.files.join(',');
        console.warn(`printing out the list of files changed ${myListOfFiles}`);

        return myDialogResult;
      }
    } catch (error) {
      if (
        AUTH_ERROR_MESSAGES.some(
          errorMessage => error.message.indexOf(errorMessage) > -1
        )
      ) {
        // If the error is an authentication error, ask the user credentials
        const credentials = await showDialog({
          title: trans.__('This test did not work!'),
          body: new GitCredentialsForm(
            trans,
            trans.__('Enter credentials for remote repository'),
            retry ? trans.__('Incorrect username or password.') : ''
          )
        });

        if (credentials.button.accept) {
          // Retry the operation if the user provides its credentials
          return await showGitOperationDialog<T>(
            model,
            operation,
            trans,
            args,
            credentials.value,
            true
          );
        }
      }
      // Throw the error if it cannot be handled or
      // if the user did not accept to provide its credentials
      throw error;
    }
  }

  /**
   * Git show dialog command - internal command, JUST FOR TESTING
   *
   * @params model {Git.Diff.IModel<string>}: The diff model to display
   * @params isText {boolean}: Optional, whether the content is a plain text
   * @returns the main area widget or null
   *
   *
   */
  export async function showGitDialog<T>(
    model: GitExtension,
    operation: Operation,
    trans: TranslationBundle,
    Title: string,
    Buttons: any,
    retry = false,
    args?: T,
    authentication?: Git.IAuth
  ): Promise<any> {
    try {
      let result: Git.IResultWithMessage;
      let test_result: Git.IChangedFilesResult;
      // the Git action
      switch (operation) {
        case Operation.ShowDialog:
          test_result = await model.show(authentication, 'WORKING', 'HEAD');
          break;
        default:
          result = { code: -1, message: 'Unknown command' };
          break;
      }
      if (result) {
        return result.message;
      } else {
        const file_information = model.status.files.map(f => {
          return { from_file: f.from, to_file: f.to, status_file: f.status };
        });
        console.log('printing file_information');
        console.log(file_information);
        console.log('printing model.status.files');
        console.log(model.status.files);
        // // ****
        // // for some reason, test_result is updated but file_information is not when we run it for the first time?
        // // #1
        const myDialog = await InputDialog.getItem({
          title:
            Title +
            ' gets information from model.status.files, which relies on me pressing the gitwidget first to initialize it',
          items: file_information.map(f => f.to_file)
        }).then(value => {
          console.log('you picked ' + value.value);
        });

        // #2
        // # this is to see if we can get the same value from using result
        const myDialogResult = await InputDialog.getItem({
          title:
            'Second dialog- supposed to have stuff in it, but only the files in changed!',
          items: test_result.files
          // items: file_information.map(f => f.to_file),
        });
        console.log(
          `this is a test to see if we can get the same value from ${myDialogResult.value}`
        );
        console.log(myDialogResult.value);

        const myListOfFiles = test_result.files.join(',');
        console.warn(`printing out the list of files changed ${myListOfFiles}`);

        myDialog;

        return myDialogResult;
      }
    } catch (error) {
      if (
        AUTH_ERROR_MESSAGES.some(
          errorMessage => error.message.indexOf(errorMessage) > -1
        )
      ) {
        // If the error is an authentication error, ask the user credentials
        const credentials = await showDialog({
          title: trans.__('This test did not work!'),
          body: new GitCredentialsForm(
            trans,
            trans.__('Enter credentials for remote repository'),
            retry ? trans.__('Incorrect username or password.') : ''
          )
        });

        if (credentials.button.accept) {
          // Retry the operation if the user provides its credentials
          return await showGitOperationDialog<T>(
            model,
            operation,
            trans,
            args,
            credentials.value,
            true
          );
        }
      }
      // Throw the error if it cannot be handled or
      // if the user did not accept to provide its credentials
      throw error;
    }
  }

  export async function gitCommit(model: GitExtension): Promise<boolean> {
    let commitMsg = '';
    // todo; try to find some way of making the commit box enforce good behavior
    try {
      const result = await InputDialog.getText({
        title: 'Enter a commit message',
        placeholder:
          'Why is this change necessary? How does this commit address the issue? What effects does this change have?'
      });
      if (result.button.accept) {
        commitMsg = result.value;
        console.log(`The commit message you entered was "${commitMsg}"`);
      } else if (result.button.className == 'Cancel') {
        console.log('you hit the cancel button for the commit box!');
        logger.log({
          message: 'you hit the cancel button',
          level: Level.ERROR
        });
        return false;
      } else if (!result.button.accept) {
        console.log("let's confirm the value of result.value");
        console.log(result.value);
        console.log('No commit message - are you sure about this?');
        logger.log({
          message: 'No commit message!',
          level: Level.ERROR
        });
        return false;
      }
    } catch (error) {
      console.error(error);
      logger.log({
        message: 'failed to commit for some reason!',
        level: Level.ERROR,
        error
      });
      return false;
    }

    if (commitMsg) {
      try {
        await model.commit(commitMsg);
      } catch (error) {
        console.error(error);
        showErrorMessage('Error when committing to repository', error);
        return false;
      }
    }
    console.log('success! we committed');
    return true;
  }

  export async function gitGetWebURL(
    model: GitExtension,
    file_name: string
  ): Promise<Git.IGetRemoteURLResult> {
    const commit_sha = model.currentBranch.top_commit;
    console.log('this is my most recent commit');
    console.log(commit_sha);
    return model.get_remote_url(commit_sha, file_name);
  }

  /**
   * Get current branch name
   * @private
   * @param model - Git extension model
   * @param retry - Is this operation retried?
   * @returns Promise for returning a name
   */
  export async function getCurrBranchName(
    model: GitExtension,
    retry = false
  ): Promise<Git.IGetCurrentBranch> {
    model.refreshBranch;
    const currBranchNameAsInterface: Git.IGetCurrentBranch = {
      current_branch: await model.get_current_branch()
    };
    return currBranchNameAsInterface;
  }

  /**
   * Handle Git add
   * @private
   * @param model - Git extension model
   * @param short_filename - Current files to add
   * @param retry - Is this operation retried?
   * @returns Promise for displaying a dialog
   */

  export async function gitAddWithBranching(
    model: GitExtension,
    short_filename: string,
    retry = false
  ): Promise<void> {
    const currBranchName = await getCurrBranchName(model).then(
      result => result.current_branch
    );
    try {
      // Git add action
      const modelAddFile = () => model.add_tc4ml(short_filename);
      const body = (
        <div>
          {'Do you want to add changes from this notebook '}
          <pre>{short_filename}</pre>
          {' to your current branch?'}
          <br />
          <br />
          {'current branch'}
          <pre>{currBranchName}</pre>
          <br />
        </div>
      );
      void showDialog({
        title: 'Git Add',
        body,
        buttons: [
          Dialog.cancelButton(),
          Dialog.warnButton({
            label: 'Change Branch',
            actions: ['change_branch']
          }),
          Dialog.warnButton({
            label: 'Make New Branch',
            actions: ['checkout']
          }),
          Dialog.okButton({ label: 'Yes' })
        ]
      }).then(async ({ button: { accept, label } }) => {
        // BUTTON ONE - GO AHEAD AND ADD A NEW FILE TO CURRENT BRANCH
        if (accept) {
          modelAddFile();
        } else if (label.includes('Make New Branch')) {
          // BUTTON TWO - MAKE A NEW BRANCH IF THEY CLICK THE MAKE A NEW BRANCH BUTTON
          let newBranchName = '';
          try {
            const nowdate = new Date();
            const newBranchDialogResult = await InputDialog.getText({
              title: 'Please name your new branch',
              placeholder: `scienceboxcloud-${nowdate}`
            });
            if (newBranchDialogResult.button.accept) {
              newBranchName = newBranchDialogResult.value;
              console.log(
                `The new branch you want to create is "${newBranchName}"`
              );
              if (newBranchName) {
                const file_name_checkout: Git.ICheckoutOptions = {
                  branchname: newBranchName,
                  newBranch: true,
                  startpoint: '',
                  filename: short_filename
                };
                try {
                  const makeNewBranchResult = await model.checkout(
                    file_name_checkout
                  );
                  if (makeNewBranchResult) {
                    console.log(
                      `success! branch has been created, and the name is ${newBranchName}`
                    );
                    console.log(
                      'WE NEED TO SEE IF OUR NEW FILE HAS BEEN COMMITED TO THIS NEW BRANCH'
                    );
                    return true;
                  } else {
                    console.log('failed to get the makeNewBranchResult');
                    return false;
                  }
                } catch (error) {
                  logger.log({
                    message: 'branch could not be created!',
                    level: Level.ERROR,
                    error
                  });
                  return false;
                }
              } else {
                console.error('we do not have a new branch name');
                logger.log({
                  message: 'missing new branch name!',
                  level: Level.ERROR
                });
                return false;
              }
            } else {
              console.log(
                'you did not hit the accept button to confirm your new branch name'
              );
              return false;
            }
          } catch (error) {
            console.log('failed to make a new branch');
          }
        } else if (label.includes('Change Branch')) {
          // BUTTON THREE - CHANGE BRANCHES TO ANOTHER EXISTING BRANCH
          console.log(
            'lets change branches - but i dont have code yet for this'
          );
          // model.branches// TODO
          return;
        } else if (!accept) {
          undefined;
        }
      });
    } catch (error) {
      console.log('something somewhere went wrong');
    }
  }

  /**
   * If the editor is in a dirty state, remind user to save, else don't bother
   */
  export async function saveNb(
    model: GitExtension,
    fullFileName: string,
    short_filename: string,
    commands: CommandRegistry,
    context: DocumentRegistry.IContext<INotebookModel>
  ): Promise<void> {
    if (!context.model.dirty) {
      return showDialog({
        title: 'Git adding current notebook to current branch.',
        body: 'Do you want to add this notebook to your current branch?',
        buttons: [
          Dialog.cancelButton({ label: 'Cancel' }),
          Dialog.okButton({ label: 'Proceed' })
        ]
      }).then(async result => {
        if (result.button.accept) {
          try {
            console.log('starting git add');
            await gitAddWithBranching(model, short_filename);
            console.log('complete - successfully added');
            logger.log({
              level: Level.SUCCESS,
              message: 'Git add complete'
            });
            return;
          } catch (error) {
            logger.log({
              level: Level.ERROR,
              message: 'Git add failed',
              error
            });
            throw error;
          }
        } else {
          return;
        }
      });
    }
    return showDialog({
      title: 'You have unsaved changes.',
      body: 'Do you want to save before proceeding to push to GHE?',
      buttons: [
        Dialog.cancelButton({ label: 'No, proceed without saving' }),
        Dialog.okButton({ label: 'Save' })
      ]
    }).then(async result => {
      if (result.button.accept) {
        try {
          commands.execute('docmanager:save');
          console.log('saving file now!');
          await gitAddWithBranching(model, short_filename);
        } catch (error) {
          throw error;
        }
      } else if (!result.button.accept) {
        try {
          await gitAddWithBranching(model, short_filename);
          console.log('succesfully git added');
        } catch (error) {
          throw error;
        }
      }
      return;
    });
  }

  export async function oldSaveFunction(
    context: DocumentRegistry.IContext<INotebookModel>
  ): Promise<void> {
    context
      .save()
      .then(() => {
        logger.log({
          message: `Successfully saved ${context.path}`,
          level: Level.SUCCESS
        });
      })
      .catch(reason => {
        logger.log({
          message: `Error saving: ${context.path}`,
          level: Level.ERROR,
          error: reason
        });
      });
  }

  export async function getCellMetadata(): Promise<any> {
    let cellNumberType = 'cell_index';
    console.log('inside getcellmeta');
    NotebookActions.executed.connect((_, args) => {
      console.log('incide notebookactions');
      const { cell, notebook } = args;
      const codeCell = cell.model.type === 'code';
      const nonEmptyCell = cell.model.value.text.length > 0;
      if (codeCell && nonEmptyCell) {
        const codeCellModel = cell.model as ICodeCellModel;
        const cellNumber =
          cellNumberType === 'cell_index'
            ? notebook.activeCellIndex
            : codeCellModel.executionCount;
        console.log(cellNumber);
        console.log(notebook.activeCellIndex);
        console.log(codeCellModel.executionCount);
        const notebookName = notebook.title.label.replace(/\.[^/.]+$/, '');
        console.log(notebookName);
        console.log('is the notebookName');
        console.log(cell);
      }
    });
  }

  export async function checkKernelConnection(
    connectionLost: IConnectionLost,
    app: JupyterFrontEnd
  ): Promise<any> {
    connectionLost = connectionLost || ConnectionLost;
    console.log(connectionLost);
    console.log('connectionLost');
    const checkKernel = await app.serviceManager.connectionFailure.connect(
      (manager, error) => connectionLost!(manager, error)
    );
    if (checkKernel) {
      return;
    } else return;
  }
  // Get the current widget and activate unless the args specify otherwise.
  export function getCurrent(
    tracker: INotebookTracker,
    shell: JupyterFrontEnd.IShell
  ): NotebookPanel | null {
    const widget = tracker.currentWidget;

    if (widget) {
      shell.activateById(widget.id);
    }

    return widget;
  }
}
/* eslint-enable no-inner-declarations */
