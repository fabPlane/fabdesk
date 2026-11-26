"""Local-session QA diagnostics; no input or focus operations after Restart now."""
import ctypes
from ctypes import wintypes as w
import json
import os
from pathlib import Path
import subprocess
import threading
import time


user=ctypes.WinDLL("user32",use_last_error=True)
kernel=ctypes.WinDLL("kernel32",use_last_error=True)
def api(dll,name,args,result):
    f=getattr(dll,name)
    f.argtypes=args
    f.restype=result
    return f

hwnd=api(user,"GetForegroundWindow",[],w.HWND)
getpid=api(user,"GetWindowThreadProcessId",[w.HWND,ctypes.POINTER(w.DWORD)],w.DWORD)
visible=api(user,"IsWindowVisible",[w.HWND],w.BOOL)
minimized=api(user,"IsIconic",[w.HWND],w.BOOL)
rect=api(user,"GetWindowRect",[w.HWND,ctypes.POINTER(w.RECT)],w.BOOL)
class_name=api(user,"GetClassNameW",[w.HWND,w.LPWSTR,ctypes.c_int],ctypes.c_int)
callback=ctypes.WINFUNCTYPE(w.BOOL,w.HWND,w.LPARAM)
enum=api(user,"EnumWindows",[callback,w.LPARAM],w.BOOL)
open_process=api(kernel,"OpenProcess",[w.DWORD,w.BOOL,w.DWORD],w.HANDLE)
close=api(kernel,"CloseHandle",[w.HANDLE],w.BOOL)
process_name=api(kernel,"QueryFullProcessImageNameW",[w.HANDLE,w.DWORD,w.LPWSTR,ctypes.POINTER(w.DWORD)],w.BOOL)
get_session=api(kernel,"ProcessIdToSessionId",[w.DWORD,ctypes.POINTER(w.DWORD)],w.BOOL)
active_session=api(kernel,"WTSGetActiveConsoleSessionId",[],w.DWORD)
class LastInput(ctypes.Structure):
    _fields_=[("size",w.UINT),("tick",w.DWORD)]
last_input=api(user,"GetLastInputInfo",[ctypes.POINTER(LastInput)],w.BOOL)
def input_tick():
    li=LastInput(ctypes.sizeof(LastInput),0)
    if not last_input(ctypes.byref(li)):
        raise ctypes.WinError(ctypes.get_last_error())
    return li.tick
def window_pid(h):
    p=w.DWORD()
    if h: getpid(h,ctypes.byref(p))
    return p.value
def snapshot():
    h=hwnd()
    p=window_pid(h)
    klass=ctypes.create_unicode_buffer(256)
    if h: class_name(h,klass,len(klass))
    name=""
    handle=open_process(0x1000,False,p) if p else None
    if handle:
        path=ctypes.create_unicode_buffer(1024)
        n=w.DWORD(len(path))
        if process_name(handle,0,path,ctypes.byref(n)): name=os.path.basename(path.value)
        close(handle)
    return dict(foregroundHwnd=h or 0,foregroundPid=p,foregroundClass=klass.value,foregroundExe=name,inputTick=input_tick())
def visible_windows(pid):
    result=[]
    @callback
    def each(h,_):
        if window_pid(h)==pid and visible(h):
            r=w.RECT()
            rect(h,ctypes.byref(r))
            if r.right-r.left>160 and r.bottom-r.top>100:
                result.append(dict(hwnd=h,minimized=bool(minimized(h)),size=[r.right-r.left,r.bottom-r.top]))
        return True
    enum(each,0)
    return result

state=None
def native_click(bridge,label,out):
    global state
    if state is None: state=Watch(out)
    state.click(bridge,label)
class Watch:
    def __init__(self,out):
        self.path=out/"windows-focus-report.json"
        self.started=time.monotonic()
        self.done=threading.Event()
        self.lock=threading.RLock()
        sid=w.DWORD()
        get_session(os.getpid(),ctypes.byref(sid))
        self.data={"observerSessionId":sid.value,"activeConsoleSessionId":active_session(),"clicks":[],"events":[]}
        self.last=None
        self.thread=threading.Thread(target=self.loop,daemon=True)
        self.thread.start()
    def elapsed(self): return round(time.monotonic()-self.started,3)
    def persist(self): self.path.write_text(json.dumps(self.data,indent=2))
    def record(self):
        snap=snapshot()
        with self.lock:
            if self.last!=snap:
                self.data["events"].append(dict(seconds=self.elapsed(),**snap))
                self.last=snap
                self.persist()
    def loop(self):
        while not self.done.is_set():
            self.record()
            self.done.wait(0.2)
    def click(self,bridge,label):
        helper=Path(__file__).with_name("windows-focus-click.ps1")
        pid=bridge.pid()
        cmd=["powershell.exe","-NoProfile","-NonInteractive","-File",str(helper),"-Action","click","-AppProcessId",str(pid),"-Label",label]
        r=subprocess.run(cmd,capture_output=True,text=True,timeout=60,creationflags=subprocess.CREATE_NO_WINDOW)
        if r.returncode:
            with self.lock:
                self.data["clickError"]=r.stderr.strip()[-900:]
                self.data["sourceWindows"]=visible_windows(pid)
                self.persist()
            raise RuntimeError("Native click could not be verified: "+r.stderr.strip()[:350])
        rec=json.loads(r.stdout)
        with self.lock:
            self.data["clicks"].append(dict(seconds=self.elapsed(),**rec))
            self.persist()
    def finish(self,pid):
        observed=[]
        for _ in range(50):
            observed.append(dict(seconds=self.elapsed(),**snapshot(),newWindows=visible_windows(pid)))
            time.sleep(0.2)
        self.done.set()
        self.thread.join(timeout=3)
        click=self.data["clicks"][-1]
        later=[s for s in self.data["events"] if s["seconds"]>=click["seconds"]]+observed
        stable=all(s["inputTick"]==click["inputAfterClick"] for s in later)
        self.data["result"]=dict(newPid=pid,windowPresent=any(s["newWindows"] for s in observed),postRestartInputUnchanged=stable,
            everForeground=any(s["foregroundPid"]==pid for s in later),
            foregroundThroughoutFinal10Seconds=all(s["foregroundPid"]==pid for s in observed),
            last=observed[-1])
        self.persist()
        print("Windows foreground evidence",json.dumps(self.data["result"]),flush=True)
