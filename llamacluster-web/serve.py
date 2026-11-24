#!/usr/bin/env python3
"""Serves dist/ (with /chat fallback) and proxies /api + /v1 to the controller, streaming included.
Remote clients must send the controller token; this proxy checks it, because the controller
would otherwise see every proxied request as local. No WebSocket support (old terminal tab)."""
import argparse,http.client,mimetypes,os
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
from urllib.parse import urlsplit
ap=argparse.ArgumentParser();ap.add_argument('--port',type=int,default=7871);ap.add_argument('--controller',default='http://127.0.0.1:7870')
ap.add_argument('--dist',default=os.path.join(os.path.dirname(os.path.abspath(__file__)),'dist'));ap.add_argument('--no-token',action='store_true');a=ap.parse_args()
C=urlsplit(a.controller);D=os.path.realpath(a.dist)
try:TOK=open(os.path.expanduser('~/.config/llamacluster/controller.token')).read().strip()
except OSError:TOK=''
class H(BaseHTTPRequestHandler):
    protocol_version='HTTP/1.1'
    def reply(self,code,data,ct='text/plain'):
        self.send_response(code);self.send_header('Content-Type',ct);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    def proxy(self):
        local=self.client_address[0] in('127.0.0.1','::1')
        if not(local or a.no_token or not TOK or self.headers.get('Authorization')=='Bearer '+TOK):return self.reply(401,b'{"error":"unauthorized"}','application/json')
        n=int(self.headers.get('Content-Length') or 0);body=self.rfile.read(n) if n else None
        c=http.client.HTTPConnection(C.hostname,C.port or 80,timeout=900)
        c.request(self.command,self.path,body,{k:v for k,v in self.headers.items() if k.lower() not in('host','connection')});r=c.getresponse()
        self.send_response(r.status)
        for k,v in r.getheaders():
            if k.lower() not in('transfer-encoding','connection','content-length'):self.send_header(k,v)
        self.send_header('Connection','close');self.end_headers();self.close_connection=True
        while True:
            b=r.read1(8192)
            if not b:break
            self.wfile.write(b);self.wfile.flush()
    def static(self):
        f=os.path.realpath(os.path.join(D,urlsplit(self.path).path.lstrip('/')))
        if not f.startswith(D) or not os.path.isfile(f):f=os.path.join(D,'index.html')
        self.reply(200,open(f,'rb').read(),mimetypes.guess_type(f)[0] or 'application/octet-stream')
    def route(self):
        try:(self.proxy if self.path.startswith(('/api/','/v1/')) else self.static)()
        except (BrokenPipeError,ConnectionResetError):pass
        except Exception as e:
            try:self.reply(502,str(e).encode())
            except Exception:pass
    do_GET=do_POST=do_DELETE=do_PUT=do_OPTIONS=route
    def log_message(self,*x):pass
print(f'serving {D} on :{a.port} -> {a.controller}');ThreadingHTTPServer(('0.0.0.0',a.port),H).serve_forever()
