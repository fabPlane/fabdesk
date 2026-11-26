import ctypes, json, os, subprocess, sys, tempfile, time, uuid
from pathlib import Path
from ctypes import wintypes as w
user=ctypes.WinDLL("user32",use_last_error=True)
kernel=ctypes.WinDLL("kernel32",use_last_error=True)
def bind(d,n,args,ret):
    f=getattr(d,n); f.argtypes=args; f.restype=ret; return f
h=bind(user,"GetForegroundWindow",[],w.HWND)
under=bind(user,"WindowFromPoint",[w.POINT],w.HWND)
root=bind(user,"GetAncestor",[w.HWND,w.UINT],w.HWND)
cursor=bind(user,"SetCursorPos",[ctypes.c_int,ctypes.c_int],w.BOOL)
class Mouse(ctypes.Structure):
    _fields_=[("x",w.LONG),("y",w.LONG),("data",w.DWORD),("flags",w.DWORD),("time",w.DWORD),("extra",ctypes.c_size_t)]
class Input(ctypes.Structure):
    _fields_=[("kind",w.DWORD),("mouse",Mouse)]
send=bind(user,"SendInput",[w.UINT,ctypes.POINTER(Input),ctypes.c_int],w.UINT)
class LI(ctypes.Structure): _fields_=[("size",w.UINT),("tick",w.DWORD)]
last=bind(user,"GetLastInputInfo",[ctypes.POINTER(LI)],w.BOOL)
mutex=bind(kernel,"CreateMutexW",[w.LPVOID,w.BOOL,w.LPCWSTR],w.HANDLE)
close=bind(kernel,"CloseHandle",[w.HANDLE],w.BOOL)
getrect=bind(user,"GetWindowRect",[w.HWND,ctypes.POINTER(w.RECT)],w.BOOL)
post=bind(user,"PostMessageW",[w.HWND,w.UINT,w.WPARAM,w.LPARAM],w.BOOL)
bind(user,"SetThreadDpiAwarenessContext",[w.HANDLE],w.HANDLE)(ctypes.c_void_p(-4))
def wait(p):
    deadline=time.monotonic()+30
    while time.monotonic()<deadline:
        if p.exists(): return p.read_text()
        time.sleep(.03)
    raise RuntimeError("timeout "+p.name)
def click(hwnd):
    r=w.RECT(); assert getrect(hwnd,ctypes.byref(r))
    p=w.POINT((r.left+r.right)//2,(r.top+r.bottom)//2)
    assert root(under(p),2)==hwnd
    assert cursor(p.x,p.y)
    time.sleep(.1)
    a=(Input*2)(); a[0].mouse.flags=2; a[1].mouse.flags=4
    assert send(2,a,ctypes.sizeof(Input))==2
def tick():
    li=LI(ctypes.sizeof(LI),0); assert last(ctypes.byref(li)); return li.tick

exe=Path(sys.argv[1])
switched=sys.argv[2]=="intervening-input"
work=Path(tempfile.mkdtemp())
name="Local\\fabdesk-focus-"+str(uuid.uuid4())
lock=mutex(None,False,name)
control=subprocess.Popen([str(exe),"control",str(work)],creationflags=subprocess.CREATE_NO_WINDOW)
wh=int(wait(work/"control-window"))
source=subprocess.Popen([str(exe),"source",str(work),name],creationflags=subprocess.CREATE_NO_WINDOW)
sh=int(wait(work/"source-window"))
time.sleep(.6)
click(sh)
wait(work/"source-click")
source.wait(timeout=25)
time.sleep(.5)
initial=tick()
if switched:
    click(wh); wait(work/"control-click")
    assert h()==wh and tick()!=initial,"competing window failed to gain true active input"
at_release=tick()
time.sleep(.5)
close(lock)
reopened=int(wait(work/"target-window"))
time.sleep(2)
end=h()
print(json.dumps(dict(case=sys.argv[2],targetForeground=end==reopened,otherForeground=end==wh,inputChangedAfterRelease=tick()!=at_release)),flush=True)
assert tick()==at_release and (end==wh if switched else end==reopened)
post(reopened,0x0010,0,0); post(wh,0x0010,0,0)
