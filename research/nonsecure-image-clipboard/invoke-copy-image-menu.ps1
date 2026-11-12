param([string]$WindowTitle = '')

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$condition = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::MenuItem
)
$items = $root.FindAll([System.Windows.Automation.TreeScope]::Subtree, $condition)
$names = @()
foreach ($item in $items) {
  $name = $item.Current.Name
  if ($name) { $names += $name }
  if ($name -match '^(Copy image|复制图片|复制图像)(\(|$)') {
    $invoke = $item.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $invoke.Invoke()
    [pscustomobject]@{ invoked = $true; name = $name; menuNames = $names } | ConvertTo-Json -Compress
    exit 0
  }
}
[pscustomobject]@{ invoked = $false; menuNames = $names } | ConvertTo-Json -Compress
exit 2
