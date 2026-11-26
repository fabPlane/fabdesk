param([Parameter(Mandatory)][string]$Marker)
$ErrorActionPreference = 'Stop'
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:GITHUB_ACTIONS -ne 'true') {
  throw 'The competing window is only for a disposable hosted Windows desktop.'
}
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object Windows.Forms.Form
$form.Text = 'Independent QA application'
$form.StartPosition = [Windows.Forms.FormStartPosition]::Manual
$form.Location = New-Object Drawing.Point(45, 45)
$form.ClientSize = New-Object Drawing.Size(380, 165)
$button = New-Object Windows.Forms.Button
$button.Text = 'Continue working here'
$button.Dock = [Windows.Forms.DockStyle]::Fill
$form.Controls.Add($button)
$form.add_Shown({
  $point = $button.PointToScreen((New-Object Drawing.Point(140,65)))
  [IO.File]::WriteAllText($Marker, (@{pid=$PID; x=$point.X; y=$point.Y} | ConvertTo-Json -Compress))
})
$button.add_Click({[IO.File]::WriteAllText("$Marker.clicked", 'native click received')})
[Windows.Forms.Application]::Run($form)
