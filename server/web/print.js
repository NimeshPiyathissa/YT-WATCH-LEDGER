// Print-ready video report: the button (and ?print=1) opens the browser's print dialog, where "Save as PDF" is a destination.
document.getElementById("printBtn").addEventListener("click", function () { window.print(); });
if (/[?&]print=1\b/.test(location.search)) window.addEventListener("load", function () { setTimeout(function () { window.print(); }, 300); });
