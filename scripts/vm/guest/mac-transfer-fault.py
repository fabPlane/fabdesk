"""Fault a real packaged update on loopback inside a disposable Apple Silicon runner."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib, json, os, platform, plistlib, runpy, socket, struct, subprocess, sys, threading, time
from pathlib import Path
from urllib.parse import urlsplit

assert os.environ.get("RUNNER_ENVIRONMENT")=="github-hosted" and platform.system()=="Darwin" and platform.machine()=="arm64"
base=Path(os.environ["RUNNER_TEMP"]).resolve()
out=base/"fault-evidence"
out.mkdir(exist_ok=True)
release=base/"public-release"
file="fabplane-0.4.26-mac-arm64.zip"
payload=release/file
manifest=json.loads((release/"manifest.json").read_text())
asset=next(a for a in manifest["assets"] if a["filename"]==file)
def digest(p):
    with p.open("rb") as src: return hashlib.file_digest(src,"sha256").hexdigest()
assert digest(payload)==asset["sha256"]=="287b049eb9f80220c2daa0a47f6f95a2b08d0f83eb864da6d0f165d87b87a0e4"
assert payload.stat().st_size==asset["size"]==531530096
events=[]
lock=threading.Lock()
began=time.monotonic()
def tick(): return round(time.monotonic()-began,3)
class Server(BaseHTTPRequestHandler):
    protocol_version="HTTP/1.1"
    def log_message(self,*args): pass
    def do_GET(self):
        path=urlsplit(self.path).path
        if path=="/manifest.json":
            data=json.dumps(manifest).encode()
            self.send_response(200); self.send_header("Content-Length",str(len(data))); self.end_headers()
            self.wfile.write(data)
            return
        if path!="/"+file: self.send_error(404); return
        with lock:
            evt={"number":len(events)+1,"started":tick(),"bytesSent":0}
            events.append(evt)
        self.send_response(200)
        self.send_header("Content-Type","application/zip")
        self.send_header("Content-Length",str(asset["size"]))
        self.send_header("Cache-Control","no-store")
        self.end_headers()
        cut=4*1024*1024 if evt["number"]==1 else asset["size"]
        with payload.open("rb") as src:
            while evt["bytesSent"]<cut:
                chunk=src.read(min(1024*1024,cut-evt["bytesSent"]))
                self.wfile.write(chunk)
                evt["bytesSent"]+=len(chunk)
        self.wfile.flush()
        if evt["number"]==1:
            time.sleep(.20)
            self.close_connection=True
            self.connection.setsockopt(socket.SOL_SOCKET,socket.SO_LINGER,struct.pack("ii",1,0))
            # Close without server.shutdown_request's graceful half-close.
            self.connection.close()
            evt["fault"]="TCP reset during body"
        evt["ended"]=tick()
class FaultServer(ThreadingHTTPServer):
    def shutdown_request(self,request): self.close_request(request)
server=FaultServer(("127.0.0.1",0),Server)
origin="http://127.0.0.1:"+str(server.server_port)
asset["url"]=origin+"/"+file
manifest["assets"]=[asset]
threading.Thread(target=server.serve_forever,daemon=True).start()
app=Path("/Applications/fabPlane.app")
exe=app/"Contents/MacOS/fabPlane"
install_info=app/"Contents/Info.plist"
assert plistlib.loads(install_info.read_bytes())["CFBundleShortVersionString"]=="0.4.24"
profile=base/"fault-profile"
assert not profile.exists()
env={**os.environ,"FABDESK_AUTOMATION":"1","FABDESK_DEV_PROFILE":"0","FABDESK_UPDATE_CHECK":"1","FABDESK_UPDATE_URL":origin+"/manifest.json","FABDESK_PROJECTS_DIR":str(base/"fault-projects"),"FABDESK_HOME":str(base/"fault-core")}
Bridge=runpy.run_path(str(Path(__file__).with_name("upgrade-drive.py")))["Bridge"]
b=Bridge(str(profile))
report={"sourceReleaseRun":os.environ["SOURCE_RUN"],"source":"0.4.24","target":"0.4.26","os":platform.mac_ver()[0],"architecture":platform.machine(),"buttonClicks":0,"publicDigest":asset["sha256"],"bytes":asset["size"],"requests":events,"case":os.environ["EXPECTATION"]}
def record(): (out/"transfer-report.json").write_text(json.dumps(report,indent=2))
def wait(f,deadline):
    stop=time.monotonic()+deadline
    while time.monotonic()<stop:
        try:
            val=f()
            if val:return val
        except (RuntimeError,OSError,ValueError,KeyError): pass
        time.sleep(.3)
    raise AssertionError("Timed out waiting for packaged UI or transfer result")
def state(): return b.eval("window.fabdesk.updateDownloadState()")
sel='[aria-label="FabDesk update"] button[aria-label="Update to 0.4.26"]'
log=base/"fault-app-private.log"
with log.open("wb") as fp:
    proc=subprocess.Popen([str(exe),"--user-data-dir="+str(profile)],stdout=fp,stderr=fp,env=env)
try:
    wait(lambda:b.eval("Boolean(document.querySelector("+json.dumps(sel)+")?.checkVisibility())"),100)
    b.screenshot(str(out/"01-visible-update.png"))
    report["sourceDesktopPid"]=b.pid()
    b.call("POST","/click",{"selector":sel})
    report["buttonClicks"]+=1
    def terminal():
        s=state()
        return s if s.get("state") in ("error","done") else None
    result=wait(terminal,240)
    report["stateAfterClick"]=result["state"]
    if result["state"]=="error": report["error"]=result["message"]
    report["updaterLog"]=[line[:450] for line in log.read_text(errors="replace").splitlines() if "[update]" in line and ("net::" in line or "aborted" in line or "status 50" in line)]
    assert events and events[0].get("fault")=="TCP reset during body"
    if os.environ["EXPECTATION"]=="baseline":
        assert result["state"]=="error" and len(events)==1,("baseline",result["state"],len(events))
        b.screenshot(str(out/"02-fault.png"))
    else:
        assert result["state"]=="done" and len(events)==2,(result.get("message"),result["state"],len(events))
        assert events[1]["bytesSent"]==asset["size"] and events[0]["bytesSent"]==4*1024*1024
        assert result["sha256"]==asset["sha256"]
        assert digest(Path(result["path"]))==asset["sha256"],"Downloaded ZIP differs from public release"
        report["cachedZipVerified"]=True
        ready=b.eval('document.querySelector(\'[aria-label="FabDesk update"]\')?.innerText')
        assert "Ready for next launch" in ready
        b.screenshot(str(out/"02-staged-after-retry.png"))
        sel2='[aria-label="FabDesk update"] button[aria-label="Restart now"]'
        b.call("POST","/click",{"selector":sel2})
        def reopened():
            s=b.call("GET","/state")["app"]
            return s if s["version"]=="0.4.26" and s["pid"]!=report["sourceDesktopPid"] else None
        new=wait(reopened,165)
        assert plistlib.loads(install_info.read_bytes())["CFBundleShortVersionString"]=="0.4.26"
        report["reopenedVersion"]=new["version"]; report["reopenedPid"]=new["pid"]
        b.screenshot(str(out/"03-reopened.png"))
    report["ok"]=True
finally:
    record()
    server.shutdown()
    if proc.poll() is None: proc.terminate()
print(json.dumps(report,indent=2))
