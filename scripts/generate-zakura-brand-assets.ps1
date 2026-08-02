param(
  [string]$Source = 'D:\Download\画板 38 (1).png',
  [string]$OutputDirectory = 'D:\github\reCloud\apps\web\public'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

New-Item -ItemType Directory -Force -Path $OutputDirectory, (Join-Path $OutputDirectory 'icons') | Out-Null

function Get-ContentBounds([System.Drawing.Bitmap]$Bitmap) {
  $minX = $Bitmap.Width
  $minY = $Bitmap.Height
  $maxX = -1
  $maxY = -1
  for ($y = 0; $y -lt $Bitmap.Height; $y++) {
    for ($x = 0; $x -lt $Bitmap.Width; $x++) {
      if ($Bitmap.GetPixel($x, $y).A -gt 8) {
        if ($x -lt $minX) { $minX = $x }
        if ($y -lt $minY) { $minY = $y }
        if ($x -gt $maxX) { $maxX = $x }
        if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  if ($maxX -lt 0) { throw 'The source image has no visible pixels.' }
  return @{ X = $minX; Y = $minY; Width = $maxX - $minX + 1; Height = $maxY - $minY + 1 }
}

function New-IconBitmap(
  [System.Drawing.Bitmap]$SourceBitmap,
  [hashtable]$Bounds,
  [int]$Size,
  [bool]$Maskable
) {
  $square = [Math]::Max($Bounds.Width, $Bounds.Height)
  $padding = [int][Math]::Round($square * 0.035)
  $cropSize = $square + ($padding * 2)
  $cropX = [Math]::Max(0, [int][Math]::Round($Bounds.X + ($Bounds.Width - $square) / 2) - $padding)
  $cropY = [Math]::Max(0, [int][Math]::Round($Bounds.Y + ($Bounds.Height - $square) / 2) - $padding)
  $cropSize = [Math]::Min($cropSize, [Math]::Min($SourceBitmap.Width - $cropX, $SourceBitmap.Height - $cropY))

  $canvas = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($canvas)
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

  if ($Maskable) {
    $graphics.Clear([System.Drawing.Color]::FromArgb(255, 15, 23, 42))
    $drawSize = [int][Math]::Round($Size * 0.76)
  } else {
    $drawSize = [int][Math]::Round($Size * 0.9)
  }
  $offset = [int][Math]::Round(($Size - $drawSize) / 2)
  $sourceRect = [System.Drawing.Rectangle]::new($cropX, $cropY, $cropSize, $cropSize)
  $destinationRect = [System.Drawing.Rectangle]::new($offset, $offset, $drawSize, $drawSize)
  $graphics.DrawImage($SourceBitmap, $destinationRect, $sourceRect.X, $sourceRect.Y, $sourceRect.Width, $sourceRect.Height, [System.Drawing.GraphicsUnit]::Pixel)
  $graphics.Dispose()
  return $canvas
}

function Save-Png([System.Drawing.Bitmap]$Bitmap, [string]$Path) {
  $Bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $Bitmap.Dispose()
}

function Get-PngBytes([System.Drawing.Bitmap]$Bitmap) {
  $stream = [System.IO.MemoryStream]::new()
  $Bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  [byte[]]$bytes = $stream.ToArray()
  $stream.Dispose()
  return $bytes
}

function Save-Ico([System.Drawing.Bitmap]$Bitmap, [string]$Path) {
  [byte[]]$png = Get-PngBytes $Bitmap
  $stream = [System.IO.FileStream]::new($Path, [System.IO.FileMode]::Create)
  $writer = [System.IO.BinaryWriter]::new($stream)
  $writer.Write([uint16]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]1)
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]32)
  $writer.Write([uint32]$png.Length)
  $writer.Write([uint32]22)
  $writer.Write($png)
  $writer.Dispose()
  $stream.Dispose()
}

$sourceBitmap = [System.Drawing.Bitmap]::new($Source)
$bounds = Get-ContentBounds $sourceBitmap

foreach ($size in @(16, 32, 48, 64, 128, 180, 192, 256, 512, 1024)) {
  $bitmap = New-IconBitmap $sourceBitmap $bounds $size $false
  if ($size -eq 16) { Save-Png $bitmap (Join-Path $OutputDirectory 'favicon-16x16.png') }
  elseif ($size -eq 32) { Save-Png $bitmap (Join-Path $OutputDirectory 'favicon-32x32.png') }
  elseif ($size -eq 512) { Save-Png $bitmap (Join-Path $OutputDirectory 'icons/icon-512.png') }
  elseif ($size -eq 192) { Save-Png $bitmap (Join-Path $OutputDirectory 'icons/icon-192.png') }
  elseif ($size -eq 180) { Save-Png $bitmap (Join-Path $OutputDirectory 'apple-touch-icon.png') }
  elseif ($size -eq 1024) { Save-Png $bitmap (Join-Path $OutputDirectory 'icons/icon-1024.png') }
  else { $bitmap.Dispose() }
}

foreach ($size in @(192, 512)) {
  $bitmap = New-IconBitmap $sourceBitmap $bounds $size $true
  Save-Png $bitmap (Join-Path $OutputDirectory "icons/icon-maskable-$size.png")
}

$favicon = New-IconBitmap $sourceBitmap $bounds 32 $false
Save-Ico $favicon (Join-Path $OutputDirectory 'favicon.ico')
$favicon.Dispose()
$sourceBitmap.Dispose()

Write-Output "Generated Zakura brand assets in $OutputDirectory"
