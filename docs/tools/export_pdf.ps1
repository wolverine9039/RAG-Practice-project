# Fill in the table of contents and export the report to PDF with Microsoft Word (Windows).
# Usage (from the project root):  powershell -ExecutionPolicy Bypass -File docs\tools\export_pdf.ps1
$ErrorActionPreference = "Stop"
$docx = (Resolve-Path "docs\UNO_RAG_Chatbot_Technical_Report.docx").Path
$pdf = [IO.Path]::ChangeExtension($docx, ".pdf")

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
    $doc = $word.Documents.Open($docx, $false, $false)
    $doc.Fields.Update() | Out-Null
    foreach ($toc in $doc.TablesOfContents) { $toc.Update() }
    $doc.Save()
    $doc.ExportAsFixedFormat($pdf, 17)   # 17 = wdExportFormatPDF
    "pages: " + $doc.ComputeStatistics(2)  # 2 = wdStatisticPages
    $doc.Close($false)
    "wrote $pdf"
}
finally {
    $word.Quit()
    [Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}
