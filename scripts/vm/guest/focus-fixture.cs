using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;
[assembly:AssemblyVersion("0.4.26.0")]
class Fixture {
    static string Quote(string s) { return "\"" + s + "\""; }
    [STAThread] static void Main(string[] args) {
        var mode=args[0]; var dir=args[1];
        var form=new Form { Text="QA "+mode,Width=320,Height=230,StartPosition=FormStartPosition.Manual,
            Location=mode=="control" ? new Point(30,90) : new Point(500,190) };
        var button=new Button { Text=mode, Dock=DockStyle.Fill };
        form.Controls.Add(button);
        form.Shown+=delegate { File.WriteAllText(Path.Combine(dir,mode+"-window"),form.Handle.ToInt64().ToString()); };
        button.Click+=async delegate {
            File.WriteAllText(Path.Combine(dir,mode+"-click"),"");
            if(mode!="source")return;
            var arm=Path.Combine(dir,"handoff");
            Directory.CreateDirectory(arm);
            var target=Assembly.GetExecutingAssembly().Location;
            var helper=Path.Combine(Path.GetDirectoryName(target),"waiter.exe");
            var psi=new ProcessStartInfo(helper, String.Join(" ",new[]{"arm",Quote(args[2]),Process.GetCurrentProcess().Id.ToString(),
                Quote(target),Quote(dir),"0.4.26",Quote(arm)})) { UseShellExecute=false,CreateNoWindow=true };
            psi.EnvironmentVariables["FABDESK_NSIS_START_ARGS"]="target "+Quote(dir);
            using(Process.Start(psi)) {}
            for(int i=0;i<100&&!File.Exists(Path.Combine(arm,"ready"));i++)await Task.Delay(30);
            if(!File.Exists(Path.Combine(arm,"ready")))throw new Exception("native helper failed to arm");
            File.WriteAllText(Path.Combine(arm,"commit"),"");
            form.Close();
        };
        Application.Run(form);
    }
}
