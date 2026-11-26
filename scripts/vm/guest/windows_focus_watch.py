"""Check idle restart foreground and a real intervening click in a second Windows app."""
import ctypes
from ctypes import wintypes as w
import json
import os
from pathlib import Path
import subprocess
import threading
import time
import uuid


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
client_rect=api(user,"GetClientRect",[w.HWND,ctypes.POINTER(w.RECT)],w.BOOL)
client_to_screen=api(user,"ClientToScreen",[w.HWND,ctypes.POINTER(w.POINT)],w.BOOL)
window_from_point=api(user,"WindowFromPoint",[w.POINT],w.HWND)
get_ancestor=api(user,"GetAncestor",[w.HWND,w.UINT],w.HWND)
set_cursor=api(user,"SetCursorPos",[ctypes.c_int,ctypes.c_int],w.BOOL)
dpi=api(user,"SetThreadDpiAwarenessContext",[w.HANDLE],w.HANDLE)
class Mouse(ctypes.Structure):
    _fields_=[("x",w.LONG),("y",w.LONG),("data",w.DWORD),("flags",w.DWORD),("time",w.DWORD),("extra",ctypes.c_size_t)]
class Input(ctypes.Structure):
    _fields_=[("kind",w.DWORD),("mouse",Mouse)]
send=api(user,"SendInput",[w.UINT,ctypes.POINTER(Input),ctypes.c_int],w.UINT)
class_name=api(user,"GetClassNameW",[w.HWND,w.LPWSTR,ctypes.c_int],ctypes.c_int)
callback=ctypes.WINFUNCTYPE(w.BOOL,w.HWND,w.LPARAM)
enum=api(user,"EnumWindows",[callback,w.LPARAM],w.BOOL)
open_process=api(kernel,"OpenProcess",[w.DWORD,w.BOOL,w.DWORD],w.HANDLE)
close=api(kernel,"CloseHandle",[w.HANDLE],w.BOOL)
process_name=api(kernel,"QueryFullProcessImageNameW",[w.HANDLE,w.DWORD,w.LPWSTR,ctypes.POINTER(w.DWORD)],w.BOOL)
get_session=api(kernel,"ProcessIdToSessionId",[w.DWORD,ctypes.POINTER(w.DWORD)],w.BOOL)
active_session=api(kernel,"WTSGetActiveConsoleSessionId",[],w.DWORD)
wait_handle=api(kernel,"WaitForSingleObject",[w.HANDLE,w.DWORD],w.DWORD)
open_mutex=api(kernel,"OpenMutexW",[w.DWORD,w.BOOL,w.LPCWSTR],w.HANDLE)
mutex=str(uuid.uuid5(uuid.UUID("50e065bc-3134-11e6-9bab-38c9862bdaf3"),"com.tensorfleet.fabdesk"))

def installer_running():
    handle=open_mutex(0x100000,False,mutex)
    if handle: close(handle)
    return bool(handle)

def click_at(point):
    assert set_cursor(point.x,point.y)
    events=(Input*2)()
    events[0].mouse.flags=2
    events[1].mouse.flags=4
    assert send(2,events,ctypes.sizeof(Input))==2, "Windows rejected native mouse input"
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
        self.case=os.environ.get("FABDESK_TEST_FOCUS_CASE")
        assert self.case in ("working","idle")
        self.other=None
        self.started=time.monotonic()
        self.done=threading.Event()
        self.lock=threading.RLock()
        sid=w.DWORD()
        get_session(os.getpid(),ctypes.byref(sid))
        self.data={"case":self.case,"observerSessionId":sid.value,"activeConsoleSessionId":active_session(),"clicks":[],"events":[]}
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
        dpi(ctypes.c_void_p(-4))
        pid=bridge.pid()
        h=hwnd()
        assert window_pid(h)==pid,"Source window did not already own foreground at input"
        selector='[aria-label="FabDesk update"] button[aria-label="'+label+'"]'
        dom="document.querySelector("+json.dumps(selector)+")"
        x,y,iw,ih=bridge.eval("(() => {const r="+dom+".getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2,innerWidth,innerHeight]})()")
        rr=w.RECT()
        assert client_rect(h,ctypes.byref(rr))
        scale=(rr.right-rr.left)/iw
        checked=False
        for dy in ((rr.bottom-rr.top)-ih*scale,0,20,28):
            point=w.POINT(round(x*scale),round(y*scale+dy))
            assert client_to_screen(h,ctypes.byref(point))
            if get_ancestor(window_from_point(point),2)!=h: continue
            if not set_cursor(point.x,point.y): continue
            time.sleep(.3)
            if bridge.eval(dom+".matches(':hover')") and hwnd()==h:
                checked=True
                break
        before=input_tick()
        assert checked and get_ancestor(window_from_point(point),2)==h and hwnd()==h, "Native FabDesk button unavailable"
        switch=self.case=="working" and label=="Restart now"
        source=open_process(0x100000,False,pid) if switch else None
        assert not switch or source, "Cannot track original FabDesk process"
        click_at(point)
        method="Win32 SendInput at renderer- and HWND-owner-verified point"
        time.sleep(.12)
        rec=dict(pid=pid,window=h,label=label,method=method,nativeHoverVerified=checked,
            foregroundImmediatelyBeforeClick=True,inputBeforeClick=before,inputAfterClick=input_tick())
        with self.lock:
            self.data["clicks"].append(dict(seconds=self.elapsed(),**rec))
            self.persist()
        if switch:
            try: self.switch_to_other_app(source)
            finally: close(source)
    def switch_to_other_app(self,source):
        assert os.environ.get("RUNNER_ENVIRONMENT")=="github-hosted" and os.environ.get("GITHUB_ACTIONS")=="true"
        assert wait_handle(source,90000)==0, "Source process did not close"
        deadline=time.monotonic()+45
        while not installer_running():
            assert time.monotonic()<deadline,"Source exited but installer mutex never appeared"
            time.sleep(.05)
        marker=self.path.parent/"other-window.json"
        script=Path(__file__).with_name("windows-other-app.ps1")
        self.other=subprocess.Popen(["powershell.exe","-NoProfile","-STA","-WindowStyle","Hidden","-File",str(script),str(marker)],creationflags=subprocess.CREATE_NO_WINDOW)
        deadline=time.monotonic()+20
        while True:
            assert self.other.poll() is None and time.monotonic()<deadline, "Companion GUI unavailable"
            try: info=json.loads(marker.read_text("utf-8-sig"))
            except (FileNotFoundError,json.JSONDecodeError):
                time.sleep(.05)
                continue
            assert info["pid"]==self.other.pid
            p=w.POINT(info["x"],info["y"])
            if window_pid(window_from_point(p))==self.other.pid: break
            time.sleep(.05)
        assert installer_running(),"Second action must happen during the real NSIS install"
        click_at(p)
        deadline=time.monotonic()+5
        while not Path(str(marker)+".clicked").exists() or window_pid(hwnd())!=self.other.pid:
            assert time.monotonic()<deadline, "Companion did not receive native click and foreground"
            time.sleep(.05)
        assert installer_running(),"Second action must finish before installer completes"
        with self.lock:
            self.data["interveningInput"]=dict(seconds=self.elapsed(),pid=self.other.pid,
                sourceExited=True,installerMutexObserved=True,companionReceivedClick=True,**snapshot())
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
        assert self.data["result"]["windowPresent"] and all(any(not w["minimized"] for w in s["newWindows"]) for s in observed)
        if self.case=="idle":
            assert stable,"Unexpected input after source restart click in idle test"
            assert self.data["result"]["foregroundThroughoutFinal10Seconds"],"Relaunched FabDesk did not own foreground"
        else:
            try:
                action=self.data["interveningInput"]
                assert not stable and action["inputTick"]!=click["inputAfterClick"]
                assert all(s["foregroundPid"]==action["pid"] for s in observed),"FabDesk displaced the other app"
                assert all(s["foregroundPid"]!=pid for s in later if s["seconds"]>=action["seconds"]),"FabDesk briefly took focus"
            finally:
                if self.other and self.other.poll() is None: self.other.terminate()
