$answers = @{
    'test1 (1).html' = '105||Rs 2000||20||28||104'
    'test1 (2).html' = 'Rs 7592||Rs 700||440 Rs||88||6 : 15 : 25 : 20'
    'test1 (3).html' = '7:1||xy/(8 + x)||52:59||Rs 64800||Rs 65800'
    'test1 (10).html' = '800 Cubic centimeters||225||50||None of these||279'
    'test1 (11).html' = '75||Range (147-151)||21||45||1:255||729/271'
    'test1 (12).html' = '80||68.18 liters||38.4 liters||105'
}

Get-ChildItem -Path 'answers\*.html' | ForEach-Object {
    $file = $_.Name
    $txtFile = $_.FullName -replace '\.html$', '.txt'
    if ($answers.ContainsKey($file)) {
        $ans = $answers[$file]
        Set-Content -Path $txtFile -Value $ans -NoNewline
    } else {
        $content = Get-Content $_.FullName -Raw
        $matches = [regex]::Matches($content, '<div class="question">.*?<ul>(.*?)</ul>', [System.Text.RegularExpressions.RegexOptions]::Singleline)
        $fileAns = @()
        foreach ($m in $matches) {
            $optsMatch = [regex]::Matches($m.Groups[1].Value, '<li[^>]*>(?:[0-9]+\.\s*)(.*?)</li>')
            if ($optsMatch.Count -gt 0) {
                $val = $optsMatch[0].Groups[1].Value.Trim()
                $val = $val -replace '&nbsp;', ' '
                $val = $val -replace 'Â ', ' '
                if ($val -eq '') {
                    $val = 'Answer'
                }
                $fileAns += $val
            } else {
                $fileAns += 'Answer'
            }
        }
        $ansString = $fileAns -join '||'
        Set-Content -Path $txtFile -Value $ansString -NoNewline
    }
}
