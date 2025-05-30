
import * as os from 'os';
import {
	workspace as Workspace, window as Window, ExtensionContext, TextDocument, OutputChannel,
	Uri, Disposable, CodeLens, FileSystemWatcher, workspace, languages
} from 'vscode';

import {
	 ConfigurationParams,
	CancellationToken, DidChangeConfigurationNotification, Middleware,
	DidChangeWatchedFilesNotification, FileChangeType
} from 'vscode-languageclient';

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind,
	StreamInfo
} from 'vscode-languageclient/node';

import { ErlangShellLSP } from './ErlangShellLSP';
import { erlangBridgePath } from '../erlangConnection';
import * as Net from 'net';

import * as lspcodelens from './lspcodelens';

import * as lspValue from './lsp-inlinevalues';
import * as lspRename from './lsp-rename';


// import { ErlangShellForDebugging } from '../ErlangShellDebugger';

// import * as erlConnection from '../erlangConnection';

// import { ErlangSettings } from '../erlangSettings';
import RebarShell from '../RebarShell';
import { ErlangOutputAdapter } from '../vscodeAdapter';
import { getElangConfigConfiguration, resolveErlangSettings } from '../ErlangConfigurationProvider';
import { ErlangLanguageClient, erlangDocumentSelector } from './lsp-context';

/*
other LSP
https://github.com/rust-lang-nursery/rls-vscode/blob/master/src/extension.ts
https://github.com/tintoy/msbuild-project-tools-vscode/blob/master/src/extension/extension.ts
https://microsoft.github.io/language-server-protocol/implementors/servers/
https://microsoft.github.io/language-server-protocol/specification
https://github.com/mtsmfm/language_server-ruby/blob/master/lib/language_server.rb


exemple TS <-> TS <--> C#
https://tomassetti.me/language-server-dot-visual-studio/

*/

export let client: LanguageClient;
let clients: Map<string, LanguageClient> = new Map();
let lspOutputChannel: OutputChannel;

namespace Configuration {

	let configurationListener: Disposable;
	let fileSystemWatcher: FileSystemWatcher;

	// Convert VS Code specific settings to a format acceptable by the server. Since
	// both client and server do use JSON the conversion is trivial. 
	export function computeConfiguration(params: ConfigurationParams, _token: CancellationToken, _next: Function): any[] {

		if (!params.items) {
			return null;
		}
		let result: any[] = [];
		for (let item of params.items) {
			if (item.section) {
				if (item.section === "<computed>") {
					result.push({
						autosave: Workspace.getConfiguration("files").get("autoSave", "afterDelay") === "afterDelay",
						tmpdir: os.tmpdir(),
						username: os.userInfo().username
					});
				} else if (item.section === "erlang") {
					result.push(resolveErlangSettings(Workspace.getConfiguration(item.section)))
				}
				else {
					result.push(Workspace.getConfiguration(item.section));
				}
			}
			else {
				result.push(null);
			}
		}
		return result;
	}

	export function initialize() {
		//force to read configuration
		lspcodelens.configurationChanged();
		// VS Code currently doesn't sent fine grained configuration changes. So we 
		// listen to any change. However this will change in the near future.
		configurationListener = Workspace.onDidChangeConfiguration(() => {
			lspcodelens.configurationChanged();
			client.sendNotification(DidChangeConfigurationNotification.type, { settings: null });
		});
		fileSystemWatcher = workspace.createFileSystemWatcher('**/*.erl');
		fileSystemWatcher.onDidCreate(uri => {
			client.sendNotification(DidChangeWatchedFilesNotification.type,
				{ changes: [{ uri: uri.fsPath, type: FileChangeType.Created }] });
		});
		fileSystemWatcher.onDidDelete(uri => {
			client.sendNotification(DidChangeWatchedFilesNotification.type,
				{ changes: [{ uri: uri.fsPath, type: FileChangeType.Deleted }] });
		});
	}

	export function dispose() {
		if (configurationListener) {
			configurationListener.dispose();
		}
	}
}



var MAX_TRIES = 10;
var WAIT_BETWEEN_TRIES_MS = 250;

/**
 * Tries to connect to a given socket location.
 * Time between retires grows in relation to attempts (attempt * RETRY_TIMER).
 *
 *  waitForSocket({ port: 2828, maxTries: 10 }, function(err, socket) {
 *  });
 *
 * Note- there is a third argument used to recursion that should
 * never be used publicly.
 *
 * Options:
 *  - (Number) port: to connect to.
 *  - (String) host: to connect to.
 *  - (Number) tries: number of times to attempt the connect.
 *
 * @param {Object} options for connection.
 * @param {Function} callback [err, socket].
 */
function waitForSocket(options: any, callback: any, _tries: any) {
	if (!options.port)
		throw new Error('.port is a required option');

	var maxTries = options.tries || MAX_TRIES;
	var host = options.host || 'localhost';
	var port = options.port;


	_tries = _tries || 0;
	if (_tries >= maxTries)
		return callback(new Error('cannot open socket'));

	function handleError() {
		// retry connection
		setTimeout(
			waitForSocket,
			// wait at least WAIT_BETWEEN_TRIES_MS or a multiplier
			// of the attempts.
			(WAIT_BETWEEN_TRIES_MS * _tries) || WAIT_BETWEEN_TRIES_MS,
			options,
			callback,
			++_tries
		);
	}

	var socket = Net.connect(port, host, () => {
		socket.removeListener('error', handleError);
		callback(null, socket);
	});
	socket.once('error', handleError);
}

/**
 * Uses the extension-provided rebar3 executable to compile the erlangbridge app.
 *
 * @param extensionPath - Path to the editor extension.
 * @returns Promise resolved or rejected when compilation is complete.
 */
// TODO: convert to async function
function compileErlangBridge(extensionPath: string): Thenable<string> {
	return new RebarShell([getElangConfigConfiguration().rebarPath], extensionPath, ErlangOutputAdapter())
		.compile(extensionPath)
		.then(({ output }) => output);
	// TODO: handle failure to compile erlangbridge
}

function getPort(callback) {
	var server = Net.createServer(function (sock) {
		sock.end('OK\n');
	});
	server.listen(0, function () {
		var port = (<Net.AddressInfo>server.address()).port;
		server.close(function () {
			callback(port);
		});
	});
}

export function activate(context: ExtensionContext) {
	let erlangCfg = getElangConfigConfiguration();
	if (erlangCfg.verbose)
		lspOutputChannel = Window.createOutputChannel('Erlang Language Server', 'erlang');

	lspValue.activate(context, lspOutputChannel);
	lspRename.activate(context, lspOutputChannel);
	
	let middleware: Middleware = {
		workspace: {
			configuration: Configuration.computeConfiguration
		},
		provideCodeLenses: (document, token) => {
			return Promise.resolve(lspcodelens.onProvideCodeLenses(document, token)).then(x => x);
		},
		resolveCodeLens: (codeLens) => {
			return Promise.resolve(lspcodelens.onResolveCodeLenses(codeLens)).then(x => x);
		},
		didSave: async (data, next) => {
			await next(data);//call LSP
			lspcodelens.onDocumentDidSave();
		}
	};
	// Options to control the language client
	let clientOptions: LanguageClientOptions = {
		// Register the server for plain text documents
		documentSelector: [{ scheme: 'file', language: 'erlang' }],
		synchronize: {
			// Notify the server about file changes to '.clientrc files contain in the workspace
			fileEvents: Workspace.createFileSystemWatcher('**/.clientrc'),
			// In the past this told the client to actively synchronize settings. Since the
			// client now supports 'getConfiguration' requests this active synchronization is not
			// necessary anymore. 
			// configurationSection: [ 'lspMultiRootSample' ]
		},
		middleware: middleware,
		diagnosticCollectionName: 'Erlang Language Server',
		outputChannel: lspOutputChannel
	}

	let clientName = erlangCfg.verbose ? 'Erlang Language Server' : '';
	client = new ErlangLanguageClient(clientName, async () => {
		return new Promise<StreamInfo>(async (resolve, reject) => {
			await compileErlangBridge(context.extensionPath);
			let erlangLsp = new ErlangShellLSP(ErlangOutputAdapter(lspOutputChannel));

			getPort(async function (port) {
				erlangLsp.Start("", erlangBridgePath, port, "src", "");
				let socket = await waitForSocket({ port: port }, 
					function (error, socket) {						
						resolve({ reader: socket, writer: socket });
					}, 
					undefined);
				//
				(<ErlangLanguageClient>client).onReady();
			});
		});
	}, clientOptions, lspOutputChannel, true);
	Configuration.initialize();
	// Start the client. This will also launch the server
	client.start();
}

export function debugLog(msg: string): void {
	if (lspOutputChannel) {
		lspOutputChannel.appendLine(msg);
	}
}

export function deactivate(): Thenable<void> {
	if (!client) {
		return undefined;
	}
	Configuration.dispose();
	return client.stop();
}
