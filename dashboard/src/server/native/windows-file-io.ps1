$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -Path (Join-Path $PSScriptRoot 'windows-file-io.cs') -ReferencedAssemblies 'System.dll', 'System.Core.dll', 'System.Web.Extensions.dll'
[LearningLoop.BoundWorker]::Run()
