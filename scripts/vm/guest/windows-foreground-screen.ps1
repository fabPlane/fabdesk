param([Parameter(Mandatory)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing,System.Windows.Forms
$area = [Windows.Forms.Screen]::PrimaryScreen.Bounds
$image = New-Object Drawing.Bitmap($area.Width,$area.Height)
$graphics = [Drawing.Graphics]::FromImage($image)
try {
  $graphics.CopyFromScreen($area.Location,[Drawing.Point]::Empty,$area.Size)
  $image.Save($Destination,[Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $image.Dispose()
}
