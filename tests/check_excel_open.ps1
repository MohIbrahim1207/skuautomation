param([string]$filePath = "C:\sku automation\Flow_Force_New_SKU_Input_Template.xlsx")

$xl = $null
try {
    $xl = New-Object -ComObject Excel.Application
    $xl.Visible = $false
    $xl.DisplayAlerts = $false
    Write-Host "Opening file in Excel: $filePath"
    $wb = $xl.Workbooks.Open($filePath)
    Write-Host "Excel Opened Workbook successfully! Sheet count: $($wb.Sheets.Count)"
    for ($i = 1; $i -le $wb.Sheets.Count; $i++) {
        $sheet = $wb.Sheets.Item($i)
        Write-Host "Sheet $i : $($sheet.Name)"
    }
    $wb.Close($false)
    Write-Host "TEST COMPLETED SUCCESSFULLY"
} catch {
    Write-Host "EXCEL FAILED TO OPEN FILE:"
    Write-Host $_.Exception.ToString()
} finally {
    if ($xl) {
        $xl.Quit()
        [System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl) | Out-Null
    }
}
