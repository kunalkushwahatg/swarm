# Test-ParsingLogic.ps1
# Unit test for hardened response parsing logic across valid, empty, null, and error payloads
$ErrorActionPreference = "Stop"

function Get-StreamedContent([string]$RawBody) {
    if ([string]::IsNullOrWhiteSpace($RawBody)) {
        return ""
    }
    $tokens = [System.Collections.Generic.List[string]]::new()
    foreach ($line in ($RawBody -split "`r?`n")) {
        $trimmed = $line.Trim()
        if ($trimmed.StartsWith("data: ")) {
            $data = $trimmed.Substring(6).Trim()
            if ($data -eq "[DONE]") { break }
            try {
                $j = $data | ConvertFrom-Json
                if ($j -and $j.choices -and $j.choices.Count -gt 0) {
                    $choice = $j.choices[0]
                    if ($choice.delta -and $choice.delta.content) {
                        $tokens.Add([string]$choice.delta.content)
                    } elseif ($choice.message -and $choice.message.content) {
                        $tokens.Add([string]$choice.message.content)
                    }
                }
            } catch {}
        }
    }
    return ($tokens -join "")
}

function Parse-InferenceResponse([string]$RawContent) {
    if ([string]::IsNullOrWhiteSpace($RawContent)) {
        return @{ Success = $false; Error = "Empty or null response received" }
    }

    # 1. Try SSE parsing
    $streamed = Get-StreamedContent -RawBody $RawContent
    if (-not [string]::IsNullOrWhiteSpace($streamed)) {
        return @{ Success = $true; Text = $streamed; Format = "SSE" }
    }

    # 2. Try JSON parsing
    try {
        $json = $RawContent | ConvertFrom-Json
        if ($json -and $json.error) {
            $errMsg = if ($json.error.message) { $json.error.message } else { [string]$json.error }
            return @{ Success = $false; Error = "API returned error: $errMsg" }
        }
        if ($json -and $json.choices -and $json.choices.Count -gt 0) {
            $choice = $json.choices[0]
            $content = if ($choice.message -and $choice.message.content) { $choice.message.content } elseif ($choice.text) { $choice.text } else { "" }
            if (-not [string]::IsNullOrWhiteSpace($content)) {
                return @{ Success = $true; Text = $content; Format = "JSON" }
            }
        }
    } catch {
        return @{ Success = $false; Error = "Failed to parse response: $_" }
    }

    return @{ Success = $false; Error = "No completion text found in response" }
}

Write-Host "Running parsing test suite..." -ForegroundColor Cyan

# Case 1: Real Swarm SSE Response
$ssePayload = @"
data: {"choices":[{"delta":{"content":"Distributed"}}],"id":1}

data: {"choices":[{"delta":{"content":" computing"}}],"id":1}

data: {"choices":[{"delta":{"content":" is useful."}}],"id":1}

data: {"choices":[{"delta":{}}],"id":1,"timings":{"tokens_generated":3}}

data: [DONE]
"@
$res1 = Parse-InferenceResponse $ssePayload
if ($res1.Success -and $res1.Text -eq "Distributed computing is useful.") {
    Write-Host "  PASS Case 1: Valid SSE stream parsed correctly: '$($res1.Text)'" -ForegroundColor Green
} else {
    throw "Case 1 failed: $($res1 | Out-String)"
}

# Case 2: Standard OpenAI JSON Response
$jsonPayload = '{"id":"chat-1","choices":[{"index":0,"message":{"role":"assistant","content":"Distributed computing is scalable."}}]}'
$res2 = Parse-InferenceResponse $jsonPayload
if ($res2.Success -and $res2.Text -eq "Distributed computing is scalable.") {
    Write-Host "  PASS Case 2: Standard JSON parsed correctly: '$($res2.Text)'" -ForegroundColor Green
} else {
    throw "Case 2 failed: $($res2 | Out-String)"
}

# Case 3: Empty / Null Response
$res3 = Parse-InferenceResponse ""
if (-not $res3.Success -and $res3.Error -match "Empty or null") {
    Write-Host "  PASS Case 3: Empty response handled safely without exception." -ForegroundColor Green
} else {
    throw "Case 3 failed: $($res3 | Out-String)"
}

# Case 4: API Error Response
$errPayload = '{"error":{"message":"Model overloaded","type":"server_error"}}'
$res4 = Parse-InferenceResponse $errPayload
if (-not $res4.Success -and $res4.Error -match "Model overloaded") {
    Write-Host "  PASS Case 4: Error response caught cleanly: $($res4.Error)" -ForegroundColor Green
} else {
    throw "Case 4 failed: $($res4 | Out-String)"
}

Write-Host "`nAll 4 parsing test cases passed successfully!" -ForegroundColor Green
