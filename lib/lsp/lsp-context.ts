
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, MessageSignature, ResponseError, ServerOptions } from 'vscode-languageclient/node';
//import { lspOutputChannel } from './lspclientextension';


export const erlangDocumentSelector = [
  { scheme: 'file', language: 'erlang' }
];

export function isErlangDocument(document: vscode.TextDocument) {
  return vscode.languages.match(erlangDocumentSelector, document);
}

export let clientIsReady: boolean = false;

export class ErlangLanguageClient extends LanguageClient {
  // Override the default implementation for failed requests. The default
  // behavior is just to log failures in the output panel, however output panel
  // is designed for extension debugging purpose, normal users will not open it,
  // thus when the failure occurs, normal users doesn't know that.
  //
  // For user-interactive operations (e.g. applyFixIt, applyTweaks), we will
  // prompt up the failure to users.
  outChannel?: vscode.OutputChannel;

  handleFailedRequest<T>(type: MessageSignature, token: vscode.CancellationToken | undefined, error: any, defaultValue: T, showNotification?: boolean): T {
    
    if (error instanceof ResponseError && type.method === 'workspace/executeCommand') {
      //show an error popup at lower right in vscode
      vscode.window.showErrorMessage(error.message);
    }
    return super.handleFailedRequest(type, token, error, defaultValue);
  }

  constructor(name: string, serverOptions: ServerOptions,
    clientOptions: LanguageClientOptions,
    lspOutputChannel: vscode.OutputChannel,
    forceDebug?: boolean) {
    super(name, serverOptions, clientOptions, forceDebug);
    this.outChannel = lspOutputChannel;
  }

  public onReady(): void {
    this.outChannel?.appendLine("LanguageClient is ready");
    clientIsReady = true;
    //not more needed 
    //return super.onReady();
  }
}