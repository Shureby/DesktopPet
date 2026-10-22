# Edge WebDriver matching the installed WebView2 (the end-to-end tests drive the app's
# windows with it), into webdriver\msedgedriver.exe. Windows CI.
$key = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
$version = (Get-ItemProperty -Path $key).pv
Write-Host "WebView2 $version"
New-Item -ItemType Directory -Force -Path webdriver | Out-Null
try {
  Invoke-WebRequest "https://msedgedriver.microsoft.com/$version/edgedriver_win64.zip" -OutFile webdriver\edgedriver.zip
  Expand-Archive webdriver\edgedriver.zip -DestinationPath webdriver -Force
} catch {
  Write-Host "Download failed ($_); using the runner's Edge WebDriver"
  Copy-Item "$env:EDGEWEBDRIVER\msedgedriver.exe" webdriver\
}
& webdriver\msedgedriver.exe --version
