
import { EventEmitter } from 'events'
import * as http from 'http';
import { DebugProtocol } from 'vscode-debugprotocol';
import { Variable } from 'vscode-debugadapter';
import * as path from 'path';
import { ErlangShellForDebugging } from './ErlangShellDebugger';
import { IErlangShellOutput } from './GenericShell';
import * as Adapter from './vscodeAdapter';
import * as fs from 'fs'; 

export var erlangBridgePath = path.join(__dirname, "..", "..", "apps", "erlangbridge", "src");

let extensionPath = "";

export function setExtensionPath(currentExtensionPath: string): void {
    extensionPath = currentExtensionPath;
    erlangBridgePath = path.join(extensionPath, "apps", "erlangbridge", "src");
}
/** this class is responsible to send/receive debug command to erlang bridge */
export abstract class ErlangConnection extends EventEmitter {
    erlangbridgePort: number;
    protected events_receiver: http.Server;
    _output: IErlangShellOutput;


    public get isConnected(): boolean {
        return this.erlangbridgePort > 0;
    }

    public constructor(output: IErlangShellOutput) {
        super();
        this._output = output;
        this.erlangbridgePort = -1;
    }

    protected log(msg: string): void {
        if (this._output) {
            this._output.appendLine(msg);
        }
    }

    protected logAppend(msg: string): void {
        if (this._output) {
            //this._output.append(msg);
        }
    }

    protected debug(msg: string): void {
        if (this._output) {
            this._output.appendLine("debug:" + msg);
        }
    }

    protected error(msg: string): void {
        if (this._output) {
            //this._output.error(msg);
        }
    }

    public async Start(): Promise<number> {
        return new Promise<number>((a, r) => {
            //this.debug("erlangConnection.Start");
            this.compile_erlang_connection().then(() => {
                return this.start_events_receiver().then(res => {
                    a(res);
                }, exitCode => {
                    //this.log("reject");
                    r(exitCode);
                });
            }, exiCode => {
                r(`Erlang compile failed : ${exiCode}`);
            });
        });
    }

    public abstract Quit() : void;

    private compile_erlang_connection(): Promise<number> {
        return new Promise<number>((a, r) => {
            //TODO: #if DEBUG
            var compiler = new ErlangShellForDebugging(this._output);
            var erlFiles = this.get_ErlangFiles();
            //create dir if not exists
            let ebinDir = path.normalize(path.join(erlangBridgePath, "..", "ebin"));
            if (!fs.existsSync(ebinDir)) {
                fs.mkdirSync(ebinDir);
            }
            
            let args = ["-o", "../ebin"].concat(erlFiles);
            return compiler.Compile(erlangBridgePath, args).then(res => {
                //this.debug("Compilation of erlang bridge...ok");
                a(res);
            }, exitCode => {
                this.error("Compilation of erlang bridge...ko");
                r(exitCode);
            });
        });
    }

    private start_events_receiver(): Promise<number> {
        this.debug("Starting http listener...");
        return new Promise<number>((accept, reject) => {
            this.events_receiver = http.createServer((req, res) => {
                var url = req.url;
                var body = [];
                var jsonBody = null;
                req.on('error', err => {
                    this.error("request error");
                }).on('data', chunk => {
                    body.push(chunk);
                }).on('end', () => {
                    //here : receive all events from erlangBridge
                    var sbody = Buffer.concat(body).toString();
                    try {
                        //this.log("body:" + sbody);
                        jsonBody = JSON.parse(sbody);
                        this.handle_erlang_event(url, jsonBody);
                    }
                    catch (err) {
                        this.error("error while receving command :" + err + "\r\n" + sbody);
                    }
                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'text/plain');
                    res.end('ok');
                });
            });
            this.events_receiver.listen(0, '127.0.0.1', () => {
                var p = this.events_receiver.address().port;
                this.debug(` on http://127.0.0.1:${p}\n`);
                accept(p);
            });

        });
    }

    protected abstract handle_erlang_event(url: string, body: any);

    protected abstract get_ErlangFiles(): string[];

    protected post(verb: string, body?: string): Promise<any> {
        return this.postorget("POST", verb, body);
    }

    private get(verb: string, body?: string): Promise<any> {
        return this.postorget("GET", verb, body);
    }

    private postorget(method: string, verb: string, body?: string): Promise<any> {
        return new Promise<any>((a, r) => {
            if (!body) {
                body = "";
            }
            var options: http.RequestOptions = {
                host: "127.0.0.1",
                path: verb,
                port: this.erlangbridgePort,
                method: method,
                headers: {
                    'Content-Type': 'plain/text',
                    'Content-Length': Buffer.byteLength(body)
                }
            }
            var postReq = http.request(options, response => {
                var body = '';
                response.on('data', buf => {
                    body += buf;
                });

                response.on('end', () => {
                    try {
                        //this.log("command response : " + body);
                        var parsed = JSON.parse(body);
                        a(parsed);
                    } catch (err) {
                        this.log("unable to parse response as JSON:" + err);
                        //console.error('Unable to parse response as JSON', err);
                        r(err);
                    }
                });
                response.on("error", err => {
                    this.log("error while sending command to erlang :" + err);
                });
            });
            postReq.write(body);
            postReq.end();
        });
    }


}