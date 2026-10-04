// ZUUWA — Payment Received report (read-only). Builds rows from existing payment records and writes a real .xlsx.
(function () {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  const ymd = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); return m ? { y: +m[1], m: +m[2], d: +m[3] } : null; };
  const serial = (p) => (Date.UTC(p.y, p.m - 1, p.d) - Date.UTC(1899, 11, 30)) / 86400000;
  const col = (i) => 'ABCDEF'[i];

  function years(Z) {
    const set = new Set(); Z.paymentService.all().forEach((p) => { const d = ymd(p.date); if (d) set.add(d.y); });
    return [...set].sort((a, b) => b - a);
  }
  // One row per payment, by payment date. Customer + invoice no. come from the saved invoice (its own snapshot).
  function rows(Z, year) {
    const out = [];
    Z.paymentService.all().forEach((p) => {
      const d = ymd(p.date); if (!d || d.y !== Number(year)) return;
      const inv = p.invoiceId ? Z.invoiceService.get(p.invoiceId) : null;
      const q = !inv && p.quotationId ? Z.quotationService.get(p.quotationId) : null;
      const cust = inv ? Z.custName(inv.customer) : q ? Z.custName(q.customer) : '';
      out.push({ month: MONTHS[d.m - 1], date: d, customer: cust, through: p.receivedThrough || '', amount: Math.round(Z.util.num(p.amount) * 100) / 100, invoiceNo: inv ? inv.number || '' : '' });
    });
    out.sort((a, b) => serial(a.date) - serial(b.date) || String(a.invoiceNo).localeCompare(String(b.invoiceNo)));
    return out;
  }

  function sheetXml(list) {
    const head = ['Bulan', 'Date', 'Nama Company/Customer', 'Payment Received Through', 'Amount', 'Invoice No'];
    const s = (r, c, v, st) => `<c r="${col(c)}${r}" t="inlineStr"${st ? ` s="${st}"` : ''}><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    const n = (r, c, v, st) => `<c r="${col(c)}${r}" s="${st}"><v>${v}</v></c>`;
    let x = `<row r="1">${head.map((h, i) => s(1, i, h, 1)).join('')}</row>`;
    list.forEach((it, i) => { const r = i + 2; x += `<row r="${r}">${s(r, 0, it.month)}${n(r, 1, serial(it.date), 2)}${s(r, 2, it.customer)}${s(r, 3, it.through)}${n(r, 4, it.amount.toFixed(2), 3)}${s(r, 5, it.invoiceNo)}</row>`; });
    const last = list.length + 1, tr = last + 2;
    const total = list.reduce((t, it) => t + it.amount, 0).toFixed(2);
    x += `<row r="${tr}">${s(tr, 3, 'Total Payment Received (RM)', 1)}<c r="E${tr}" s="4"><f>SUM(E2:E${last})</f><v>${total}</v></c></row>`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols><col min="1" max="1" width="13" customWidth="1"/><col min="2" max="2" width="13" customWidth="1"/><col min="3" max="3" width="42" customWidth="1"/><col min="4" max="4" width="28" customWidth="1"/><col min="5" max="5" width="16" customWidth="1"/><col min="6" max="6" width="20" customWidth="1"/></cols>
<sheetData>${x}</sheetData>
<autoFilter ref="A1:F${last}"/>
</worksheet>`;
  }
  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="#,##0.00"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE3F1F7"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF006994"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  function loadJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    return new Promise((res, rej) => { const sc = document.createElement('script'); sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'; sc.onload = () => res(window.JSZip); sc.onerror = () => rej(new Error('Could not load the Excel library. Check your internet connection.')); document.head.appendChild(sc); });
  }
  async function buildXlsx(list, year) {
    const JSZip = await loadJSZip(); const z = new JSZip(); const sheet = 'Payments ' + year;
    z.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`);
    z.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
    z.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheet)}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${esc(sheet)}'!$A$1:$F$${list.length + 1}</definedName></definedNames></workbook>`);
    z.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    z.file('xl/worksheets/sheet1.xml', sheetXml(list));
    z.file('xl/styles.xml', STYLES);
    return z.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  async function exportYear(Z, year) {
    const list = rows(Z, year);
    if (!list.length) return { empty: true, count: 0 };
    const blob = await buildXlsx(list, year); const name = 'ZUUWA_Payment_Report_' + year + '.xlsx';
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    return { empty: false, count: list.length, total: list.reduce((t, it) => t + it.amount, 0), name };
  }
  window.ZWReport = { years, rows, buildXlsx, exportYear };
})();
