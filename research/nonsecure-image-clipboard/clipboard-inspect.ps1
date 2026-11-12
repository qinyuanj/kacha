param(
  [switch]$Clear,
  [switch]$RequireImage,
  [string]$ExpectedPngSha256 = ''
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Invoke-ClipboardWithRetry([scriptblock]$Action) {
  for ($attempt = 0; $attempt -lt 12; $attempt++) {
    try { return & $Action } catch {
      if ($attempt -eq 11) { throw }
      Start-Sleep -Milliseconds 100
    }
  }
}

if ($Clear) {
  Invoke-ClipboardWithRetry { [System.Windows.Forms.Clipboard]::Clear() }
  [pscustomobject]@{ cleared = $true } | ConvertTo-Json -Compress
  exit 0
}

$data = Invoke-ClipboardWithRetry { [System.Windows.Forms.Clipboard]::GetDataObject() }
if ($null -eq $data) {
  [pscustomobject]@{ formats = @(); nativeFormats = @(); hasImage = $false } | ConvertTo-Json -Compress
  exit 0
}

function Get-Bytes($value) {
  if ($null -eq $value) { return $null }
  $stream = New-Object System.IO.MemoryStream
  if ($value -is [System.IO.Stream]) {
    $value.Position = 0
    $value.CopyTo($stream)
  } elseif ($value -is [byte[]]) {
    $stream.Write($value, 0, $value.Length)
  } else {
    return $null
  }
  return $stream.ToArray()
}

function Get-Hash([byte[]]$bytes) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

$result = [ordered]@{
  formats = @($data.GetFormats())
  nativeFormats = @($data.GetFormats($false))
  hasImage = [System.Windows.Forms.Clipboard]::ContainsImage()
}
$hasVerifiedImage = $false

foreach ($name in @('PNG', 'DeviceIndependentBitmap')) {
  $bytes = Get-Bytes ($data.GetData($name))
  if ($null -ne $bytes) {
    $result[$name] = [ordered]@{ length = $bytes.Length; sha256 = Get-Hash $bytes }
    if ($name -eq 'PNG') {
      $signature = [byte[]]@(137, 80, 78, 71, 13, 10, 26, 10)
      $validSignature = $bytes.Length -ge 8
      for ($i = 0; $i -lt 8 -and $validSignature; $i++) { $validSignature = $bytes[$i] -eq $signature[$i] }
      $result[$name]['signatureValid'] = $validSignature
      if ($validSignature) { $hasVerifiedImage = $true }
    }
    if ($name -eq 'DeviceIndependentBitmap' -and $bytes.Length -ge 20) {
      $result[$name]['headerSize'] = [BitConverter]::ToUInt32($bytes, 0)
      $result[$name]['width'] = [BitConverter]::ToInt32($bytes, 4)
      $result[$name]['height'] = [BitConverter]::ToInt32($bytes, 8)
      $result[$name]['bitCount'] = [BitConverter]::ToUInt16($bytes, 14)
      if ($result[$name]['headerSize'] -ge 40 -and $result[$name]['width'] -ne 0 -and $result[$name]['height'] -ne 0) { $hasVerifiedImage = $true }
    }
  }
}

$bitmap = $data.GetData([System.Windows.Forms.DataFormats]::Bitmap)
if ($bitmap -is [System.Drawing.Bitmap]) {
  $memory = New-Object System.IO.MemoryStream
  try {
    $bitmap.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $memory.ToArray()
    if ($bitmap.Width -gt 0 -and $bitmap.Height -gt 0) { $hasVerifiedImage = $true }
    $result['Bitmap'] = [ordered]@{
      width = $bitmap.Width
      height = $bitmap.Height
      pixelFormat = $bitmap.PixelFormat.ToString()
      pngLength = $bytes.Length
      pngSha256 = Get-Hash $bytes
    }
  } finally {
    $memory.Dispose()
    $bitmap.Dispose()
  }
}

$html = $data.GetData([System.Windows.Forms.DataFormats]::Html)
if ($html -is [string]) {
  $result['HTML Format'] = [ordered]@{
    length = $html.Length
    hasImg = $html -match '<img\b'
    hasDataUrl = $html -match 'data:image/'
    excerpt = $html.Substring(0, [Math]::Min(500, $html.Length))
  }
}
$files = $data.GetData([System.Windows.Forms.DataFormats]::FileDrop)
if ($files -is [System.Array]) { $result['FileDrop'] = @($files) }
$result['hasBitmapFormat'] = @($result.formats | Where-Object { $_ -in @('Bitmap', 'DeviceIndependentBitmap', 'PNG') }).Count -gt 0
$result['hasVerifiedImage'] = $hasVerifiedImage
if ($ExpectedPngSha256) { $result['expectedPngSha256Matches'] = $null -ne $result['PNG'] -and $result['PNG'].sha256 -eq $ExpectedPngSha256 }

$json = [pscustomobject]$result | ConvertTo-Json -Depth 6 -Compress
Write-Output $json
if ($RequireImage -and (-not $result.hasVerifiedImage -or ($ExpectedPngSha256 -and -not $result.expectedPngSha256Matches))) { exit 2 }
