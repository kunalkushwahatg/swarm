# Configure-ComputerAFirewall.ps1 - Elevate & Configure Inbound Firewall on Computer A
# Run this script in an Elevated (Administrator) PowerShell window on Computer A.
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  Swarm Milestone 12 - Computer A Firewall Configuration" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Elevation Check
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error "This script requires Administrator privileges. Please right-click PowerShell and choose 'Run as Administrator'."
    exit 1
}

$targetExe = "C:\Users\kunal\OneDrive\Desktop\swarm\build-cuda\swarm_node.exe"
Write-Host "`n[Step 1] Inspecting existing application rules for:" -ForegroundColor Yellow
Write-Host "  $targetExe" -ForegroundColor White

$appFilters = Get-NetFirewallApplicationFilter | Where-Object { $_.Program -eq $targetExe }
$disabledCount = 0

foreach ($af in $appFilters) {
    $ruleName = $af.CreationClassName.Split("|")[-1]
    $rule = Get-NetFirewallRule -Name $ruleName -ErrorAction SilentlyContinue
    if ($rule -and $rule.Direction -eq "Inbound" -and $rule.Enabled -eq "True" -and $rule.Action -eq "Allow") {
        $addrFilter = Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $rule -ErrorAction SilentlyContinue
        if ($addrFilter -and ($addrFilter.RemoteAddress -eq "Any" -or $addrFilter.RemoteAddress -contains "Any")) {
            Write-Host "  Disabling broad unrestricted rule: $($rule.Name)" -ForegroundColor Yellow
            Disable-NetFirewallRule -Name $rule.Name
            $disabledCount++
        }
    }
}
Write-Host "  Disabled $disabledCount broad application rule(s)." -ForegroundColor Green

# 2. Create or Update Restricted Rule
Write-Host "`n[Step 2] Creating/Updating restricted inbound rule for Computer B..." -ForegroundColor Yellow
$restrictedRuleName = "Swarm-Coordinator-Hotspot-B-Restricted"

# Remove existing version if present
Get-NetFirewallRule -Name $restrictedRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule

$newRule = New-NetFirewallRule -DisplayName "Swarm Coordinator - Hotspot B Restricted" `
    -Name $restrictedRuleName `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort 8080 `
    -LocalAddress "192.168.137.174" `
    -RemoteAddress "192.168.137.1" `
    -Program $targetExe `
    -Profile Public,Private `
    -Enabled True

Write-Host "  Created rule: $restrictedRuleName" -ForegroundColor Green

# 3. Verification using -AssociatedNetFirewallRule
Write-Host "`n[Step 3] Verifying rule properties via associated filters..." -ForegroundColor Yellow

$verifiedRule = Get-NetFirewallRule -Name $restrictedRuleName
$verifiedAddr = Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $verifiedRule
$verifiedPort = Get-NetFirewallPortFilter -AssociatedNetFirewallRule $verifiedRule
$verifiedApp  = Get-NetFirewallApplicationFilter -AssociatedNetFirewallRule $verifiedRule

[PSCustomObject]@{
    RuleName      = $verifiedRule.Name
    DisplayName   = $verifiedRule.DisplayName
    Enabled       = $verifiedRule.Enabled
    Action        = $verifiedRule.Action
    Direction     = $verifiedRule.Direction
    Profile       = $verifiedRule.Profile
    Protocol      = $verifiedPort.Protocol
    LocalPort     = $verifiedPort.LocalPort
    LocalAddress  = $verifiedAddr.LocalAddress
    RemoteAddress = $verifiedAddr.RemoteAddress
    Program       = $verifiedApp.Program
} | Format-List

Write-Host "==========================================================" -ForegroundColor Green
Write-Host "  FIREWALL CONFIGURATION SUCCESSFULLY APPLIED AND VERIFIED" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
