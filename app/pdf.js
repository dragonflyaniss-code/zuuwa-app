/* ZUUWA — PDF service. Builds real A4 vector PDFs with jsPDF + AutoTable. */
(function () {
  'use strict';
  const ZW = (window.ZW = window.ZW || {});
  const JSPDF = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
  const AUTOTABLE = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.31/jspdf.plugin.autotable.min.js';
  const INK = [32, 30, 29], MUTED = [96, 93, 93], BODY = [58, 55, 55], ACC = [0, 105, 148], TINT = [232, 244, 249], YELLOW = [240, 182, 0], RULE = [170, 166, 166], SOFT = [238, 237, 237], WHITE = [255, 255, 255], NAVY = [14, 42, 78], LABELBG = [232, 238, 243];

  let libP = null, mergeP = null;
  const PDFLIB = 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';
  const ensureMerge = () => { if (window.PDFLib) return Promise.resolve(); if (!mergeP) mergeP = loadScript(PDFLIB).catch(() => { mergeP = null; throw new ZW.AppError('Could not load the PDF merge engine. Please check your internet connection and try again.'); }); return mergeP; };
  const dataToBytes = (u) => { const b = atob(String(u).split(',')[1] || ''); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; };
  async function appendPdfs(mainBytes, list) {
    await ensureMerge(); const { PDFDocument } = window.PDFLib;
    const out = await PDFDocument.load(mainBytes);
    for (const f of list) {
      try { const src = await PDFDocument.load(dataToBytes(f.data), { ignoreEncryption: true }); const pages = await out.copyPages(src, src.getPageIndices()); pages.forEach((pg) => out.addPage(pg)); }
      catch (e) { throw new ZW.AppError('Could not read the attached PDF "' + (f.name || f.title || 'attachment') + '". It may be damaged or password-protected.'); }
    }
    return new Blob([await out.save()], { type: 'application/pdf' });
  }
  const loadScript = (src) => new Promise((res, rej) => { const el = document.createElement('script'); el.src = src; el.onload = res; el.onerror = () => rej(new Error('load ' + src)); document.head.appendChild(el); });
  function ensureLibs() {
    const ok = () => window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API.autoTable;
    if (ok()) return Promise.resolve();
    if (!libP) libP = (window.jspdf ? Promise.resolve() : loadScript(JSPDF)).then(() => (ok() ? null : loadScript(AUTOTABLE))).then(() => { if (!ok()) throw new Error('autotable'); })
      .catch(() => { libP = null; throw new ZW.AppError('Could not load the PDF engine. Please check your internet connection and try again.'); });
    return libP;
  }
  const imgInfo = (src) => new Promise((res) => {
    if (!src) return res(null);
    const im = new Image(); im.onload = () => res({ src, w: im.naturalWidth || 1, h: im.naturalHeight || 1, fmt: /^data:image\/png/i.test(src) ? 'PNG' : 'JPEG' }); im.onerror = () => res(null); im.src = src;
  });
  const money = (n) => ZW.fmt.number(n);
  const cur = () => ZW.settingsService.get().document.currency || 'RM';

  function makeDoc(opts) {
    opts = { trueJustify: true, sp: 1, ...(opts || {}) }; const SP = opts.sp;
    const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4', compress: true });
    const W = 210, H = 297, M = 16, CW = W - 2 * M, TOP = 20, BOTTOM = H - 19;
    const st = { y: M };
    const setF = (size, style, color) => { doc.setFont('helvetica', style || 'normal'); doc.setFontSize(size); doc.setTextColor(...(color || INK)); };
    const addrLines = (text, width) => {
      const out = [];
      String(text || '').split('\n').forEach((raw) => {
        const t = raw.trim().replace(/\s+/g, ' '); if (!t) return;
        if (doc.getTextWidth(t) <= width) { out.push(t); return; }
        let parts;
        if (t.indexOf(',') >= 0) parts = t.split(/,\s*/).filter(Boolean).map((x, i, a) => (i < a.length - 1 ? x + ',' : x));
        else parts = t.replace(/\s+(?=(TAMAN|TMN|JALAN|JLN|LORONG|KAMPUNG|KG\.?|BANDAR|PERSIARAN)\b)/gi, '\u0001').replace(/\s+(?=\d{5}\b)/g, '\u0001')
          .replace(/\s+(?=(PULAU PINANG|PENANG|SELANGOR|KUALA LUMPUR|JOHOR|KEDAH|KELANTAN|MELAKA|NEGERI SEMBILAN|PAHANG|PERAK|PERLIS|SABAH|SARAWAK|TERENGGANU|PUTRAJAYA|LABUAN)\s*$)/i, '\u0001').split('\u0001');
        let cur = '';
        parts.forEach((pt) => {
          const force = /^\d{5}\b/.test(pt);
          const next = cur ? cur + ' ' + pt : pt;
          if (cur && (force || doc.getTextWidth(next) > width)) { out.push(cur); cur = pt; } else cur = next;
        });
        if (cur) out.push(cur);
      });
      return out.reduce((acc, l) => acc.concat(doc.getTextWidth(l) > width ? doc.splitTextToSize(l, width) : [l]), []);
    };
    const lh = (size, k) => size * 0.3528 * (k || 1.4) * (SP < 1 ? 0.96 : 1);
    const ensure = (h) => { if (st.y + h > BOTTOM) { doc.addPage(); st.y = TOP; return true; } return false; };
    const rule = (y, w, color, x1, x2) => { doc.setDrawColor(...(color || RULE)); doc.setLineWidth(w || 0.2); doc.line(x1 == null ? M : x1, y, x2 == null ? W - M : x2, y); };
    const para = (text, o) => {
      o = o || {}; const size = o.size || 9; const x = (o.x == null ? M : o.x) + (o.indent || 0); const width = (o.width == null ? CW : o.width) - (o.indent || 0); const L = lh(size, o.k);
      setF(size, o.style, o.color || INK);
      String(text == null ? '' : text).split('\n').forEach((raw) => {
        const lines = raw.trim() === '' ? [''] : doc.splitTextToSize(raw.trim(), width);
        lines.forEach((line, li) => {
          if (ensure(L)) setF(size, o.style, o.color || INK);
          const just = o.justify !== false && li < lines.length - 1 && line.trim().indexOf(' ') > 0 && doc.getTextWidth(line) > width * 0.8;
          const yy = st.y + L * 0.72;
          if (opts.trueJustify && li < lines.length - 1) {
            const words = line.trim().split(/\s+/); const ww = words.map((wd) => doc.getTextWidth(wd)); const sum = ww.reduce((a, b) => a + b, 0);
            const gap = words.length > 1 ? (width - sum) / (words.length - 1) : 0;
            if (words.length > 1 && gap > 0 && gap < doc.getTextWidth(' ') * 4) { let cx = x; words.forEach((wd, k) => { doc.text(wd, cx, yy); cx += ww[k] + gap; }); }
            else doc.text(line, x, yy);
          } else if (just && !opts.trueJustify) doc.text(line, x, yy, { align: 'justify', maxWidth: width }); else doc.text(line, x, yy);
          st.y += L;
        });
      });
      st.y += (o.after == null ? 1.5 : o.after) * SP;
    };
    const label = (text, o) => {
      o = o || {}; ensure(o.need || 18); st.y += (o.before == null ? 2.8 : o.before) * SP;
      rule(st.y, 0.6, INK); st.y += 3.3 + 0.6 * SP; setF(7.5, 'bold', ACC); doc.text(text.toUpperCase(), M, st.y, { charSpace: 0.4 }); st.y += 2.9 + 0.5 * SP;
    };
    const header = (c, title, rows, logo) => {
      const top = M; let x = M;
      if (logo) { const s = Math.min(34 / logo.w, 20 / logo.h); try { doc.addImage(logo.src, logo.fmt, M, top, logo.w * s, logo.h * s); x = M + logo.w * s + 5; } catch (e) {} }
      const leftW = 110 - (x - M);
      setF(13.5, 'bold', INK); let ly = top + 5;
      doc.splitTextToSize(c.name || '', leftW).forEach((l) => { doc.text(l, x, ly); ly += 5.4; });
      setF(8, 'normal', MUTED);
      const info = [c.regNo ? '(' + c.regNo + ')' : '', ...String(c.address || '').split('\n'), [c.phone && 'Tel: ' + c.phone, c.email].filter(Boolean).join('   ·   '), c.website].filter((s) => s && s.trim());
      info.forEach((line) => doc.splitTextToSize(line.trim(), leftW).forEach((l) => { doc.text(l, x, ly); ly += 3.7; }));
      setF(title.length > 12 ? 15 : 20, 'bold', ACC); doc.text(title, W - M, top + 6.5, { align: 'right' });
      let ry = top + 13.5; const lx = W - M - 60;
      rows.filter((r) => r).forEach(([k, v]) => {
        setF(7.5, 'normal', MUTED); doc.text(k, lx, ry);
        setF(8.5, 'bold', INK); const vl = doc.splitTextToSize(String(v || '-'), 36); doc.text(vl, W - M, ry, { align: 'right' }); ry += 4.5 * Math.max(1, vl.length);
      });
      st.y = Math.max(ly, ry, logo ? top + 21 : 0) + 2;
      doc.setFillColor(...ACC); doc.rect(M, st.y, CW, 0.9, 'F'); st.y += 4.5;
    };
    const headerQ = (c, title, rows, logo) => {
      const top = 11, rightW = 64, gap = 5;
      let lw = 0, lhgt = 0; if (logo) { const s = Math.min(44 / logo.w, 26 / logo.h); lw = logo.w * s; lhgt = logo.h * s; }
      const x = logo ? M + lw + gap : M; const leftW = CW - rightW - 6 - (x - M);
      doc.setFont('helvetica', 'bold'); let ns = 13.5; doc.setFontSize(ns); while (ns > 10 && doc.getTextWidth(c.name || '') > leftW) { ns -= 0.25; doc.setFontSize(ns); } const nameL = doc.splitTextToSize(c.name || '', leftW);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
      const infoL = [];
      if (c.regNo) doc.splitTextToSize('(' + c.regNo + ')', leftW).forEach((l) => infoL.push(l));
      addrLines(c.address, leftW).forEach((l) => infoL.push(l));
      [[c.phone && 'Tel: ' + c.phone, c.email].filter(Boolean).join('   ·   '), c.website].filter((s) => s && s.trim()).forEach((line) => doc.splitTextToSize(line.trim(), leftW).forEach((l) => infoL.push(l)));
      const blockH = 4.1 + (nameL.length - 1) * 5.4 + (infoL.length ? 4.2 + (infoL.length - 1) * 3.6 : 0) + 0.6;
      const bh = Math.max(blockH, lhgt);
      if (logo) { try { doc.addImage(logo.src, logo.fmt, M, top + (bh - lhgt) / 2, lw, lhgt); } catch (e) {} }
      let ly = top + (bh - blockH) / 2 + 4.1;
      setF(ns, 'bold', INK); nameL.forEach((l) => { doc.text(l, x, ly); ly += 5.4; }); ly -= 4.8;
      setF(8, 'normal', MUTED); infoL.forEach((l) => { ly += 3.6; doc.text(l, x, ly); });
      const rx = W - M - rightW;
      if (title) { let ts = 19; setF(ts, 'bold', ACC); while (ts > 14 && doc.getTextWidth(title) > rightW + 4) { ts -= 0.5; setF(ts, 'bold', ACC); } doc.text(title, W - M, top + 6.5, { align: 'right' }); }
      let ry = top + (title ? 12.3 : 5); const lx = W - M - 60;
      rows.filter((r) => r).forEach(([k, v]) => {
        setF(7.5, 'normal', MUTED); doc.text(k, lx, ry);
        setF(8.5, 'bold', INK); const vl = doc.splitTextToSize(String(v || '-'), 36); doc.text(vl, W - M, ry, { align: 'right' }); ry += 4.2 * Math.max(1, vl.length);
      });
      st.y = Math.max(top + bh, ry - 2.6) + 2.2 * SP;
      doc.setFillColor(...ACC); doc.rect(M, st.y, CW, 0.9, 'F'); st.y += 3 * SP;
    };
    const infoBox = (rows) => {
      rows = rows.filter(([, v]) => String(v || '').trim()); if (!rows.length) return;
      const kw = 24, vw = CW - kw - 3, L = lh(8.8, 1.3);
      setF(8.8, 'bold', INK); const lines = rows.map(([k, v]) => [k, doc.splitTextToSize(String(v).trim(), vw)]);
      ensure(lines.reduce((s, [, vl]) => s + vl.length * L, 0) + 30);
      lines.forEach(([k, vl]) => {
        setF(8.3, 'normal', MUTED); doc.text(k, M, st.y + L * 0.72); doc.text(':', M + kw, st.y + L * 0.72);
        setF(8.8, 'bold', INK); vl.forEach((l, i) => doc.text(l, M + kw + 3, st.y + L * 0.72 + i * L));
        st.y += vl.length * L + 0.6 * SP;
      });
      st.y += 2 * SP;
    };
    const details = (groups) => {
      const kw = 30, vw = CW - kw - 3, L = lh(8.8, 1.3);
      groups.forEach((rows, gi) => {
        rows = rows.filter((r) => r && r[1] != null);
        rows.forEach(([k, v, o]) => {
          setF(8.8, (o && o.bold) ? 'bold' : 'normal', INK); const vl = doc.splitTextToSize(String(v).trim() || '-', vw);
          ensure(vl.length * L + 1);
          setF(8.3, 'normal', MUTED); doc.text(k, M, st.y + L * 0.72); doc.text(':', M + kw, st.y + L * 0.72);
          setF(8.8, (o && o.bold) ? 'bold' : 'normal', INK); vl.forEach((l, i) => doc.text(l, M + kw + 3, st.y + L * 0.72 + i * L));
          st.y += vl.length * L + 0.4;
        });
        if (gi < groups.length - 1 && rows.length) st.y += 2.2 * SP;
      });
      st.y += 1.5 * SP;
    };
    const parties = (cols) => {
      const gap = 10, w = cols.length === 1 ? Math.min(CW, 100) : (CW - gap * (cols.length - 1)) / cols.length, y0 = st.y; let maxY = y0;
      cols.forEach((col, i) => {
        const x = M + i * (w + gap); let y = y0 + 2.6;
        setF(7.5, 'bold', ACC); doc.text(col.label.toUpperCase(), x, y, { charSpace: 0.4 }); y += 5;
        if (col.kv) {
          const kw = 21, L = lh(8.8, 1.3);
          col.kv.filter(([, v]) => String(v || '').trim()).forEach(([k, v]) => {
            setF(8.8, 'bold', INK); const vl = [].concat(...String(v).trim().split('\n').map((raw) => doc.splitTextToSize(raw.trim(), w - kw - 3)));
            setF(8.3, 'normal', MUTED); doc.text(k, x, y); doc.text(':', x + kw, y);
            setF(8.8, 'bold', INK); vl.forEach((t, j) => doc.text(t, x + kw + 3, y + j * L));
            y += vl.length * L + 0.6 * SP;
          });
          maxY = Math.max(maxY, y); return;
        }
        col.lines.filter((l) => l && String(l.t || '').trim()).forEach((l) => {
          const size = l.size || 9; setF(size, l.bold ? 'bold' : 'normal', l.muted ? MUTED : INK);
          (l.addr ? addrLines(l.t, w) : [].concat(...String(l.t).split('\n').map((raw) => doc.splitTextToSize(raw.trim(), w)))).forEach((t) => { doc.text(t, x, y); y += lh(size, 1.3); });
        });
        maxY = Math.max(maxY, y);
      });
      st.y = maxY + 1.8 * SP;
    };
    const itemsTable = (lines, topt) => {
      topt = topt || {}; const BUL = !!topt.bullets; const DF = BUL ? 8.4 : 8.1, BI = 3.4;
      const DESC_W = CW - (9 + 15 + 13 + 25 + 28), PV = 1.1 + 0.5 * SP;
      const body = lines.map((l, i) => { const lump = l.pricing === 'lump'; const hasQ = String(l.qty == null ? '' : l.qty).trim() !== '' && ZW.util.num(l.qty) > 0; return [String(i + 1), '', lump ? (hasQ ? ZW.fmt.qty(l.qty) : '1') : ZW.fmt.qty(l.qty), lump ? (hasQ ? (l.unit || '') : 'Lot') : (l.unit || ''), lump ? 'Lump Sum' : money(l.rate), money(l.amount)]; });
      doc.autoTable({
        startY: st.y, margin: { left: M, right: M, top: TOP, bottom: H - BOTTOM }, theme: 'plain',
        head: [['No.', 'Description of Works', 'Qty', 'Unit', 'Rate (' + cur() + ')', 'Amount (' + cur() + ')']], body,
        styles: { font: 'helvetica', fontSize: 8.6, textColor: INK, cellPadding: { top: PV, right: 2, bottom: PV, left: 2 }, valign: 'top', overflow: 'linebreak', lineWidth: 0 },
        headStyles: BUL ? { fontStyle: 'bold', fontSize: 8.8, textColor: INK, valign: 'middle', cellPadding: { top: 2, right: 2, bottom: 2, left: 2 } } : { fontStyle: 'bold', fontSize: 7.2, textColor: MUTED },
        columnStyles: { 0: { cellWidth: 9 }, 1: { cellWidth: DESC_W }, 2: { cellWidth: 15, halign: 'right' }, 3: { cellWidth: 13 }, 4: { cellWidth: 25, halign: 'right' }, 5: { cellWidth: 28, halign: 'right', fontStyle: 'bold' } },
        rowPageBreak: 'avoid', showHead: 'everyPage',
        didParseCell: (d) => {
          if (d.section === 'head' && [2, 4, 5].indexOf(d.column.index) >= 0) d.cell.styles.halign = 'right';
          if (d.section === 'body' && d.column.index === 1) {
            const it = lines[d.row.index];
            doc.setFont('helvetica', 'bold'); doc.setFontSize(8.6); const n = doc.splitTextToSize(it.name || '-', DESC_W - 4);
            doc.setFont('helvetica', 'normal'); doc.setFontSize(DF);
            if (BUL) {
              const items = ZW.itemPoints(it).map((x) => String(x).trim()).filter(Boolean);
              const groups = items.map((t) => [].concat(...t.split('\n').map((ln) => doc.splitTextToSize(ln.trim(), DESC_W - 4 - BI))));
              const bh = groups.length ? 1 + groups.reduce((s, g) => s + g.length * DF * 0.3528 * 1.2 + 0.7, 0) - 0.7 : 0;
              d.cell._n = n; d.cell._d = []; d.cell._b = groups; d.cell.text = [''];
              d.cell.styles.minCellHeight = 2 * PV + n.length * 8.6 * 0.3528 * 1.15 + bh + 0.6;
            } else {
              const ds = String(it.description || '').trim() ? doc.splitTextToSize(String(it.description).trim(), DESC_W - 4) : [];
              d.cell._n = n; d.cell._d = ds; d.cell.text = [''];
              d.cell.styles.minCellHeight = 2 * PV + n.length * 8.6 * 0.3528 * 1.15 + (ds.length ? 0.3 + ds.length * 8.1 * 0.3528 * 1.15 : 0) + 0.6;
            }
          }
        },
        willDrawCell: (d) => { if (d.section === 'body' && d.column.index === 1) d.cell.text = []; },
        didDrawCell: (d) => {
          if (d.section === 'body' && d.column.index === 1 && d.cell._n) {
            const x = d.cell.x + 2; let y = d.cell.y + PV; const L = 8.6 * 0.3528 * 1.15;
            doc.setFont('helvetica', 'bold'); doc.setFontSize(8.6); doc.setTextColor(...INK); doc.text(d.cell._n, x, y, { baseline: 'top', lineHeightFactor: 1.15 }); y += d.cell._n.length * L;
            if (d.cell._b && d.cell._b.length) {
              doc.setFont('helvetica', 'normal'); doc.setFontSize(DF); doc.setTextColor(...MUTED);
              const L2 = DF * 0.3528 * 1.2, bw = DESC_W - 4 - BI, sp = doc.getTextWidth(' '); let yy = y + 1;
              d.cell._b.forEach((g) => {
                doc.text('•', x + 0.4, yy, { baseline: 'top' });
                g.forEach((ln, li) => {
                  const words = String(ln).trim().split(/\s+/); let done = false;
                  if (li < g.length - 1 && words.length > 1) {
                    const ww = words.map((wd) => doc.getTextWidth(wd)); const gap = (bw - ww.reduce((a, b) => a + b, 0)) / (words.length - 1);
                    if (gap > 0 && gap < sp * 4) { let cx = x + BI; words.forEach((wd, k) => { doc.text(wd, cx, yy, { baseline: 'top' }); cx += ww[k] + gap; }); done = true; }
                  }
                  if (!done) doc.text(ln, x + BI, yy, { baseline: 'top' });
                  yy += L2;
                });
                yy += 0.7;
              });
            }
            if (d.cell._d.length) {
              doc.setFont('helvetica', 'normal'); doc.setFontSize(8.1); doc.setTextColor(...MUTED);
              const L2 = 8.1 * 0.3528 * 1.15, dw = DESC_W - 4, sp = doc.getTextWidth(' ');
              d.cell._d.forEach((ln, li) => {
                const yy = y + 0.3 + li * L2; const words = String(ln).trim().split(/\s+/);
                if (li < d.cell._d.length - 1 && words.length > 1) {
                  const ww = words.map((wd) => doc.getTextWidth(wd)); const gap = (dw - ww.reduce((a, b) => a + b, 0)) / (words.length - 1);
                  if (gap > 0 && gap < sp * 4) { let cx = x; words.forEach((wd, k) => { doc.text(wd, cx, yy, { baseline: 'top' }); cx += ww[k] + gap; }); return; }
                }
                doc.text(ln, x, yy, { baseline: 'top' });
              });
            }
          }
          if (d.column.index === 0) { const y = d.cell.y + d.cell.height; if (d.section === 'head') rule(y, 0.6, INK); else rule(y, 0.2, RULE); }
        },
      });
      st.y = doc.lastAutoTable.finalY + 2.5 * SP;
    };
    const totals = (rows, words, topt) => {
      topt = topt || {}; const below = !!topt.wordsBelow;
      const bw = 84, x = W - M - bw;
      const h = rows.reduce((s, r) => s + (r[2] && r[2].band ? 9.4 : 5.4), 0);
      setF(8.3, 'italic', INK); const wl = words ? doc.splitTextToSize(words, below ? bw - 6 : CW - bw - 8) : [];
      ensure(below ? h + (wl.length ? wl.length * 3.8 + 6 : 0) + 2 : Math.max(h, wl.length * 3.8 + 8) + 2);
      const y0 = st.y; let y = y0;
      if (words && !below) { setF(7, 'bold', MUTED); doc.text('AMOUNT IN WORDS', M, y0 + 4, { charSpace: 0.3 }); setF(8.3, 'italic', INK); doc.text(wl, M, y0 + 8.5); }
      rows.forEach(([k, v, o]) => {
        o = o || {};
        if (o.band) { if (!topt.plain) { doc.setFillColor(...TINT); doc.rect(x, y + 0.6, bw, 5.6, 'F'); } setF(9.4, 'bold', INK); doc.text(k, x + 3, y + 4.6); doc.text(v, W - M - 3, y + 4.6, { align: 'right' });
          doc.setDrawColor(...YELLOW); doc.setLineWidth(0.45); doc.line(x, y + 7.3, W - M, y + 7.3); doc.line(x, y + 8.4, W - M, y + 8.4); y += 9.4; }
        else { setF(8.5, o.bold ? 'bold' : 'normal', o.muted ? MUTED : INK); doc.text(k, x + 3, y + 3.9); doc.text(v, W - M - 3, y + 3.9, { align: 'right' }); y += 5.4; rule(y, 0.15, RULE, x, W - M); }
      });
      if (below && wl.length) {
        setF(7, 'bold', MUTED); doc.text('AMOUNT IN WORDS', x + 3, y + 1.8, { charSpace: 0.3 });
        setF(8.3, 'italic', INK); doc.text(wl, x + 3, y + 5.4, { lineHeightFactor: 1.3 });
        y += 5.4 + (wl.length - 1) * 3.8 + 1.2;
        st.y = y + 2 * SP; return;
      }
      st.y = Math.max(y, y0 + 8.5 + wl.length * 3.8) + 2.5;
    };
    const amountDue = (amount, words, desc) => {
      const pad = 3.5, rw = 58, lw = CW - rw - pad * 2;
      setF(8.6, 'normal', INK); const wl = doc.splitTextToSize(words || '', lw);
      setF(8.2, 'normal', MUTED); const dl = desc ? doc.splitTextToSize('Payment Description: ' + desc, lw) : [];
      const h = pad + 4 + wl.length * lh(8.6, 1.3) + (dl.length ? 0.6 + dl.length * lh(8.2, 1.3) : 0) + pad - 1;
      ensure(h + 2); const y0 = st.y;
      doc.setDrawColor(...NAVY); doc.setLineWidth(0.35); doc.rect(M, y0, CW, h);
      let y = y0 + pad + 3; setF(9.4, 'bold', NAVY); doc.text('AMOUNT DUE', M + pad, y, { charSpace: 0.4 }); y += 4.4;
      setF(8.6, 'normal', INK); wl.forEach((l) => { doc.text(l, M + pad, y); y += lh(8.6, 1.3); });
      if (dl.length) { y += 0.6; setF(8.2, 'normal', MUTED); dl.forEach((l) => { doc.text(l, M + pad, y); y += lh(8.2, 1.3); }); }
      setF(16, 'bold', NAVY); doc.text(amount, W - M - pad, y0 + h / 2 + 2, { align: 'right' });
      st.y = y0 + h + 3 * SP;
    };
    const bankTable = (rows) => {
      const kw = 42, rh = 6.6; ensure(rows.length * rh + 4); const y0 = st.y;
      rows.forEach(([k, v], i) => {
        const y = y0 + i * rh;
        doc.setFillColor(...LABELBG); doc.rect(M, y, kw, rh, 'F');
        setF(8.6, 'bold', INK); doc.text(k, M + 3, y + rh / 2 + 1.1);
        setF(8.8, 'normal', INK); doc.text(doc.splitTextToSize(String(v || '-'), CW - kw - 6)[0] || '-', M + kw + 3, y + rh / 2 + 1.1);
      });
      doc.setDrawColor(...RULE); doc.setLineWidth(0.25); doc.rect(M, y0, CW, rows.length * rh); doc.line(M + kw, y0, M + kw, y0 + rows.length * rh);
      for (let i = 1; i < rows.length; i++) doc.line(M, y0 + i * rh, W - M, y0 + i * rh);
      st.y = y0 + rows.length * rh + 3 * SP;
    };
    const numbered = (items, o) => {
      o = o || {};
      items.forEach((s, i) => {
        ensure(12);
        if (s.title != null) {
          setF(8.8, 'bold', INK); doc.text((i + 1) + '.', M, st.y + 3.3);
          const tl = doc.splitTextToSize(s.title || '', CW - 7); doc.text(tl, M + 7, st.y + 3.3, o.tight ? { lineHeightFactor: 1.35 } : undefined); st.y += o.tight ? tl.length * lh(8.8, 1.35) : tl.length * lh(8.8, 1.3) + 0.8 * SP;
          para(s.body, o.tight ? { size: 8.3, indent: 7, color: BODY, k: 1.35, after: 1.41 } : { size: 8.3, indent: 7, color: BODY, after: 1.4 });
        } else {
          setF(8.4, 'normal', BODY); doc.text((i + 1) + '.', M, st.y + 3.1); para(s.body, o.tight ? { size: 8.4, indent: 7, color: BODY, k: 1.35, after: 1.41 } : { size: 8.4, indent: 7, color: BODY, after: 1.2 });
        }
      });
    };
    const formRows = (rows) => {
      const lw = 44;
      rows.filter((r) => r && String(r[1] || '').trim()).forEach(([k, v, o]) => {
        o = o || {}; setF(o.size || 9, o.style || 'normal', INK);
        const vl = []; String(v).split('\n').forEach((raw) => vl.push(...doc.splitTextToSize(raw.trim(), CW - lw)));
        const h = vl.length * lh(o.size || 9, 1.3) + 2.6; ensure(h);
        setF(7.6, 'bold', MUTED); doc.text(k.toUpperCase(), M, st.y + 3.5, { charSpace: 0.25 });
        setF(o.size || 9, o.style || 'normal', INK); doc.text(vl, M + lw, st.y + 3.5, { lineHeightFactor: 1.3 });
        st.y += h + 0.6 * SP; rule(st.y, 0.15, RULE);
      });
      st.y += 2 * SP;
    };
    const attachments = async (atts, pdfList) => {
      const valid = []; for (const a of atts || []) { const info = await imgInfo(a.image); if (info) valid.push({ ...info, title: a.title }); }
      label('Attachments', { need: valid.length ? 90 : 18 });
      const pl = (pdfList || []).filter((x) => x && x.data);
      if (!valid.length) { para(pl.length ? 'Attached PDF document' + (pl.length > 1 ? 's' : '') + ' (enclosed after this quotation): ' + pl.map((x, i) => (i + 1) + '. ' + (x.title || x.name || 'Document')).join('   ') : 'Attachment: None', { size: 8.8, color: pl.length ? BODY : MUTED }); return; }
      const gap = 6, cw = (CW - gap) / 2, boxH = Math.round(58 * (0.55 + 0.45 * SP));
      for (let i = 0; i < valid.length; i += 2) {
        const pair = valid.slice(i, i + 2); setF(8.3, 'bold', INK);
        const caps = pair.map((p, j) => doc.splitTextToSize('Fig. ' + (i + j + 1) + '   ' + (String(p.title || '').trim() || 'Untitled'), cw));
        const capH = Math.max(...caps.map((c) => c.length)) * lh(8.3, 1.3) + 1.5;
        ensure(boxH + capH + 3); st.y += SP;
        pair.forEach((p, j) => {
          const x = M + j * (cw + gap);
          doc.setFillColor(...SOFT); doc.rect(x, st.y, cw, boxH, 'F');
          const s = Math.min((cw - 4) / p.w, (boxH - 4) / p.h); const w = p.w * s, h = p.h * s;
          try { doc.addImage(p.src, p.fmt, x + (cw - w) / 2, st.y + (boxH - h) / 2, w, h, undefined, 'FAST'); } catch (e) {}
          setF(8.3, 'bold', INK); doc.text(caps[j], x, st.y + boxH + 4.4, { lineHeightFactor: 1.3 });
        });
        st.y += boxH + capH + 3.5 * SP;
      }
    };
    const signatures = async (c, blocks, stampImg, stampPos) => {
      const sig = await imgInfo(c.signature); const stp = stampImg ? await imgInfo(stampImg) : null; ensure(40); st.y += 3.5 * SP;
      const sp0 = stampPos || {}; const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
      const gap = 18, w = (CW - gap) / 2, y0 = st.y;
      blocks.forEach((b, i) => {
        const x = M + i * (w + gap);
        setF(8, 'normal', MUTED); doc.text(b.label, x, y0 + 3);
        if (b.stamp && stp) {
          // Stamp sits beside the authorised signature (right of the signing line), independently adjustable.
          const sx0 = M + Math.min(w * 0.85, 55) + 4; const k = clamp(Number(sp0.scale) || 100, 60, 150) / 100;
          const bw = 38 * k, bh = 26 * k, s = Math.min(bw / stp.w, bh / stp.h), iw = stp.w * s, ih = stp.h * s;
          const px = clamp(sx0 + (Number(sp0.dx) || 0), sx0 - 2, W - M - iw), py = clamp(y0 + 2 + (24 - ih) / 2 + (Number(sp0.dy) || 0), y0 - 6, y0 + 34 - ih);
          try { doc.addImage(stp.src, stp.fmt, px, py, iw, ih); } catch (e) {} return;
        }
        if (b.stamp && b.blankIfNone) return;
        if (b.stamp) { doc.setDrawColor(...RULE); doc.setLineWidth(0.3); doc.setLineDashPattern([1.2, 1.2], 0); doc.rect(x, y0 + 5.5, w, 22); doc.setLineDashPattern([], 0); setF(7.5, 'normal', MUTED); doc.text('Company stamp', x + 3, y0 + 10); return; }
        if (b.useSig && sig) { const s = Math.min(40 / sig.w, 13 / sig.h); try { doc.addImage(sig.src, sig.fmt, x, y0 + 6.5, sig.w * s, sig.h * s); } catch (e) {} }
        rule(y0 + 21, 0.3, INK, x, x + Math.min(w * 0.85, 55));
        setF(8.8, 'bold', INK); doc.text(b.name || ' ', x, y0 + 25.2);
        setF(8, 'normal', MUTED); doc.text([b.sub, b.org].filter(Boolean), x, y0 + 29.2, { lineHeightFactor: 1.35 });
      });
      st.y = y0 + 34 + 4 * SP;
    };
    const finish = (c, docLabel) => {
      const n = doc.getNumberOfPages(); const s = ZW.settingsService.get();
      for (let i = 1; i <= n; i++) {
        doc.setPage(i); rule(H - 15, 0.3, INK);
        setF(7, 'normal', MUTED); doc.text(doc.splitTextToSize(s.document.footer || c.name || '', 118)[0] || '', M, H - 10.5);
        doc.text(docLabel + '   ·   Page ' + i + ' of ' + n, W - M, H - 10.5, { align: 'right' });
        if (i > 1) { setF(7.5, 'bold', INK); doc.text(c.name || '', M, 12); setF(7.5, 'normal', MUTED); doc.text(docLabel, W - M, 12, { align: 'right' }); rule(14.5, 0.3, RULE); }
      }
    };
    return { doc, st, W, H, M, CW, setF, lh, ensure, rule, para, label, header, headerQ, infoBox, details, parties, itemsTable, totals, amountDue, bankTable, numbered, formRows, attachments, signatures, finish };
  }

  // Person names only: "mOhD fIrDaUs bin ahmad" -> "Mohd Firdaus Bin Ahmad". Stored value is never changed.
  const personName = (v) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ').toLowerCase().replace(/(^|[\s\-'’\/.(])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  const COMPANY_RE = /\b(sdn|bhd|berhad|enterprise|ventures?|trading|holdings?|construction|services?|engineering|resources|industries|corporation|corp|company|co|ltd|llp|plc|inc|group|management|development|builders?|contractors?|solutions?|jabatan|majlis|perbadanan|kementerian|pejabat|sekolah|universiti|hospital|masjid|surau)\b|&|\(m\)/i;
  // Title case for invoice customer / location fields (keeps line breaks).
  // Smart title case: lowercase words get a capital first letter; ALL-CAPS words (JKK, HQ, ABC) and
  // intentional mixed case (iPhone, McDonald) are kept exactly as typed. Numbers/punctuation untouched.
  const smartWord = (w) => {
    const L = w.replace(/[^\p{L}]/gu, ''); if (!L) return w;
    if (L === L.toUpperCase()) return w;
    if (L === L.toLowerCase()) return w.replace(/\p{L}/u, (c) => c.toUpperCase());
    if (/^\p{Lu}[\p{Ll}\d]*$/u.test(w)) return w;
    if (/^\p{Ll}{1,2}\p{Lu}\p{Ll}{2,}\d*$/u.test(w) || /^\p{Lu}\p{Ll}+\p{Lu}\p{Ll}+\d*$/u.test(w)) return w;
    const lw = w.toLowerCase(); return lw.replace(/\p{L}/u, (c) => c.toUpperCase());
  };
  const titleCase = (v) => String(v == null ? '' : v).split('\n').map((ln) => ln.replace(/[ \t]+/g, ' ').trim().replace(/[\p{L}\p{N}]+/gu, smartWord)).join('\n');
  const invoiceCustomer = (cu) => ({ ...cu, name: titleCase(cu.name), company: titleCase(cu.company), address: titleCase(cu.address) });
  const areaText = (p) => { const v = String((p && p.area) || '').trim(); if (!v) return ''; if (/^\d[\d,]*(\.\d+)?$/.test(v)) return v + ' ' + ((p && p.areaUnit) || 'm²'); return titleCase(v).replace(/(^|[^\p{L}])(m²|m2|m³|m3|sq\.?\s?ft|sqft|sq\.?\s?m|ft²|ft|mm|cm|km|m)(?![\p{L}])/giu, (x, pre, u) => pre + u.toLowerCase()); };
  const nameOrCompany = (v, isCompany) => (isCompany || COMPANY_RE.test(String(v || '')) ? v : personName(v));
  const typeOf = (doc) => { const q = doc && doc.quotationId ? ZW.quotationService.get(doc.quotationId) : null; const inv = doc && doc.invoiceId ? ZW.invoiceService.get(doc.invoiceId) : null; const cu = (inv && inv.customer) || (q && q.customer) || null; return cu ? cu.type || (String(cu.company || '').trim() && !String(cu.name || '').trim() ? 'company' : '') : ''; };
  const need = (cond, msg) => { if (!cond) throw new ZW.AppError('Cannot generate PDF: ' + msg); };
  const customerLines = (cu) => (cu.type === 'company' ? [{ t: cu.company || cu.name, bold: true }, { t: cu.company && cu.name ? 'Attn: ' + personName(cu.name) : '' }] : cu.type === 'individual' ? [{ t: personName(cu.name), bold: true }] : [{ t: personName(cu.name), bold: true }, { t: cu.company }]).concat([ { t: cu.address, muted: true, addr: true }, { t: cu.phone && 'Tel: ' + cu.phone, muted: true }, { t: cu.email, muted: true }]);
  const logoOf = async (s) => (s.document.showLogo ? imgInfo(s.company.logo) : null);

  async function quotationPdf(q, sp) {
    need(q && String(q.number || '').trim(), 'quotation number is missing.'); need(q.customer && ZW.custName(q.customer), 'customer name is missing.'); need((q.items || []).length, 'the quotation has no job scope.');
    const s = ZW.settingsService.get(), c = s.company, B = makeDoc({ sp }), f = ZW.fmt, t = ZW.calcTotals(q);
    B.headerQ(c, 'QUOTATION', [['Quotation No.', q.number], ['Date', f.date(q.date)], ['Valid Until', f.date(q.validUntil)]], await logoOf(s));
    B.parties([{ label: 'Prepared for', lines: customerLines(q.customer) }]);
    B.para('We are pleased to submit our quotation for the following waterproofing works:', { size: 8.8, color: BODY, after: 2.5 });
    B.infoBox([['Project', q.project && q.project.name], ['Site Location', q.project && q.project.siteAddress], ['Area', q.project && q.project.area]].filter((r) => r[0] !== 'Area' || String(r[1] || '').trim()));
    B.itemsTable(t.lines, { bullets: true });
    const rows = [['Subtotal', money(t.subtotal)]];
    if (t.discount) rows.push(['Discount' + (q.discount.type === 'percent' ? ' (' + ZW.util.num(q.discount.value) + '%)' : ''), '- ' + money(t.discount), { muted: true }]);
    if (t.tax) rows.push([(q.tax.label || 'Tax') + ' (' + ZW.util.num(q.tax.rate) + '%)', money(t.tax)]);
    rows.push(['GRAND TOTAL (' + cur() + ')', money(t.total), { band: true }]);
    B.totals(rows, null);
    B.label('Terms & Conditions', { need: 30 }); B.numbered(ZW.quotationService.termsSections(q).map((sec) => {
      if (sec.title !== 'Warranty') return sec;
      const w = ZW.quotationService.warrantyEntries(q);
      return { title: 'Warranty', body: w.length ? w.map((e) => e.title + ' — ' + e.period).join('\n') : sec.body };
    }), { tight: true });
    await B.attachments(q.attachments, q.pdfAttachments);
    await B.signatures(c, [
      { label: 'Prepared by', name: personName(c.authorizedPerson), sub: c.authorizedTitle, org: 'For ' + c.name, useSig: true },
      { label: 'Accepted by (Customer)', name: 'Name:', sub: 'Company stamp (if applicable):', org: 'Date:' },
    ]);
    if (String(s.quotation.footer || '').trim()) B.para(s.quotation.footer, { size: 8, color: MUTED, style: 'italic' });
    B.finish(c, 'Quotation ' + q.number);
    return { doc: B.doc, filename: 'Quotation_' + q.number + '.pdf' };
  }

  async function invoicePdf(inv, sp) {
    need(inv && String(inv.number || '').trim(), 'invoice number is missing.'); need(inv.customer && ZW.custName(inv.customer), 'customer name is missing.');
    const s = ZW.settingsService.get(), c = s.company, B = makeDoc({ sp }), f = ZW.fmt, IS = ZW.invoiceService;
    const t = ZW.calcTotals(inv), b = IS.billing(inv);
    const title = 'INVOICE';
    const tDays = inv.dueDate && inv.date ? Math.round((new Date(inv.dueDate) - new Date(inv.date)) / 864e5) : null;
    B.headerQ(c, title, [['Invoice No.', inv.number], ['Date', f.date(inv.date)], String(inv.poNumber || '').trim() ? ['P/O No.', String(inv.poNumber).trim()] : null, tDays != null && !isNaN(tDays) ? ['Term', tDays > 0 ? tDays + ' Days' : 'C.O.D.'] : null, inv.type ? ['Type of Invoice', ({ Full: 'Full Payment', Progress: 'Progress Payment', Final: 'Final Payment' })[inv.type] || inv.type] : null].filter(Boolean), await logoOf(s));
    B.parties([{ label: 'Bill to', lines: customerLines(invoiceCustomer(inv.customer || {})) }, { label: 'Project / Site', kv: [['Project', titleCase(inv.project && inv.project.name)], ['Site Address', titleCase(inv.project && inv.project.siteAddress)], ['Area', areaText(inv.project)]] }]);
    if (String(inv.description || '').trim()) B.para(String(inv.description).trim(), { size: 8.8, color: BODY, after: 2 });
    B.itemsTable(t.lines, { bullets: true });
    let rows;
    if (inv.type === 'Full') {
      rows = [['Subtotal', money(t.subtotal)]];
      if (t.discount) rows.push(['Discount', '- ' + money(t.discount), { muted: true }]);
      if (t.tax) rows.push([(inv.tax.label || 'Tax') + ' (' + ZW.util.num(inv.tax.rate) + '%)', money(t.tax)]);
      if (b.previous) rows.push([b.byPayments ? 'Less: Payment Received (Deposit)' : 'Less: Previously Billed', '- ' + money(b.previous), { muted: true }]);
      rows.push(['INVOICE TOTAL (' + cur() + ')', money(b.amount), { band: true }]);
    } else {
      rows = [['Contract Sum', money(b.projectTotal)]];
      if (inv.type === 'Balance') rows.push([b.byPayments ? 'Less: Payment Received (Deposit)' : 'Less: Previously Billed', '- ' + money(b.previous), { muted: true }]);
      rows.push([inv.type.toUpperCase() + ' AMOUNT (' + cur() + ')', money(b.amount), { band: true }]);
    }
    B.totals(rows, null, { plain: true });
    const d = B.doc;
    const pct = b.projectTotal > 0 ? Math.round((b.amount / b.projectTotal) * 100) : 0;
    const payDesc = ({ Full: 'Full Payment', Deposit: 'Deposit', Balance: 'Balance', Progress: 'Progress Payment', Final: 'Final Payment' })[inv.type] || String(inv.paymentDescription || '').trim() || (inv.type ? inv.type : '');
    B.amountDue(cur() + ' ' + money(b.amount), f.words(b.amount).replace(/^Ringgit Malaysia /, 'Ringgit Malaysia: ') + '.', payDesc);
    if (c.bankName || c.bankAccount || c.bankAccountName) {
      B.bankTable([['Bank Name', c.bankName], ['Account Name', c.bankAccountName || c.name], ['Account No.', c.bankAccount]]);
    }
    if (String(inv.notes || '').trim()) { B.label('Notes', { need: 20 }); B.para(inv.notes, { size: 8.5, color: BODY }); }
    B.label('Terms & Conditions', { need: 30 });
    B.numbered(s.invoice.terms.filter((x) => String(x.title || x.body || '').trim()).map((x) => ({ title: x.title, body: ZW.util.fill(x.body, { dueDays: s.invoice.dueDays, company: c.name }) })), { tight: true });
    await B.signatures(c, [{ label: 'Authorised by', name: personName(c.authorizedPerson), sub: c.authorizedTitle, org: 'For ' + c.name, useSig: true }]);
    B.para('This is a computer-generated invoice.', { size: 7.5, color: MUTED });
    B.finish(c, 'Invoice ' + inv.number);
    return { doc: B.doc, filename: 'Invoice_' + inv.number + '.pdf' };
  }

  async function receiptPdf(r, sp) {
    need(r && String(r.number || '').trim(), 'receipt number is missing.'); need(r.customer && String(r.customer.name || '').trim(), 'customer name is missing.'); need(ZW.util.num(r.amount) > 0, 'amount is missing.');
    const s = ZW.settingsService.get(), c = s.company, B = makeDoc({ sp }), f = ZW.fmt;
    B.headerQ(c, 'OFFICIAL RECEIPT', [['Receipt No.', r.number], ['Date', f.date(r.date)], r.invoiceNumber ? ['Invoice Ref.', r.invoiceNumber] : null], await logoOf(s));
    B.st.y += 1;
    B.formRows([
      ['Received from', nameOrCompany(r.customer.name, typeOf(r) === 'company'), { style: 'bold', size: 10 }], ['Address', r.customer.address], ['Contact', r.customer.phone],
      ['The sum of', f.words(r.amount), { style: 'italic' }], ['Being payment for', r.description], ['Invoice no.', r.invoiceNumber],
      ['Payment method', r.method], ['Reference', r.reference], ['Payment status', r.status || 'Fully Paid', { style: 'bold' }],
    ]);
    B.ensure(20); const y = B.st.y + 1, d = B.doc;
    d.setFillColor(...LABELBG); d.setDrawColor(...NAVY); d.setLineWidth(0.35); d.rect(B.M, y, 80, 15, 'FD');
    B.setF(7.2, 'bold', NAVY); d.text('AMOUNT RECEIVED', B.M + 4, y + 4.8, { charSpace: 0.4 });
    B.setF(15, 'bold', NAVY); d.text(cur() + ' ' + money(r.amount), B.M + 4, y + 11.6);
    if (r.status === 'Fully Paid') { d.setDrawColor(...ACC); d.setLineWidth(0.7); d.rect(B.M + 86, y + 2, 42, 11); B.setF(10.5, 'bold', ACC); d.text('FULLY PAID', B.M + 90, y + 9.1, { charSpace: 0.5 }); }
    B.st.y = y + 18;
    await B.signatures(c, [{ label: 'Received by', name: personName(c.authorizedPerson), sub: c.authorizedTitle, org: 'For ' + c.name, useSig: true }, { label: '', stamp: true }]);
    if (String(s.receipt.footer || '').trim()) B.para(s.receipt.footer, { size: 7.8, color: MUTED, style: 'italic' });
    B.finish(c, 'Receipt ' + r.number);
    return { doc: B.doc, filename: 'Receipt_' + r.number + '.pdf' };
  }

  async function warrantyPdf(w, sp) {
    need(w && String(w.number || '').trim(), 'warranty number is missing.'); need(String(w.customerName || '').trim(), 'customer name is missing.'); need(String(w.scopeTitle || '').trim(), 'work scope is missing.');
    const s = ZW.settingsService.get(), c = s.company, B = makeDoc({ trueJustify: true, sp }), f = ZW.fmt;
    const cat = s.categories.find((x) => x.id === w.categoryId); const ctx = { company: c.name, customer: nameOrCompany(w.customerName, typeOf(w) === 'company'), site: w.siteName || w.siteAddress, scope: w.scopeTitle, period: w.period };
    B.headerQ(c, '', [['Warranty No.', w.number], ['Date', f.date(w.date)], w.invoiceNumber ? ['Invoice Ref.', w.invoiceNumber] : null], await logoOf(s));
    B.setF(12, 'bold', ACC); B.doc.text('PRODUCT AND SERVICE WARRANTY', B.W / 2, B.st.y + 3.2, { align: 'center' }); B.st.y += 5;
    B.label('Warranty Details', { need: 50, before: 1 });
    const cap = (x) => String(x || '').replace(/\b\w/g, (m) => m.toUpperCase());
    const exp = ZW.warrantyService.expiry(w);
    const periodTxt = f.date(w.startDate) + ' – ' + (exp ? f.date(exp) : '-') + ' (' + cap(w.period) + ')';
    const groups = [[['Client Name', titleCase(w.customerName || '')], ['Contact No.', w.contactNo || ''], ['Client Address', titleCase(w.projectAddress || '')], ['Project Name', titleCase(w.siteName || '')], ['Site Location', titleCase(w.siteAddress || '')], String(w.area || '').trim() ? ['Area', areaText({ area: w.area, areaUnit: w.areaUnit || ((w.invoiceId && ZW.invoiceService.get(w.invoiceId)) || {}).project?.areaUnit || '' })] : null, String(w.scopeTitle || '').trim() ? ['Job Scope', String(w.scopeTitle).trim()] : null, ['Warranty Period', periodTxt, { bold: true }]]];
    if (w.warrantyType === 'subcontractor') {
      const mc = w.mainContractor || {}, ap = w.applicator || {};
      groups.push([['Main Contractor', mc.name || ''], ['Address', mc.address || ''], ['Contact No.', mc.phone || '']]);
      groups.push([['Applicator', ap.name || ''], ['Address', ap.address || ''], ['Contact No.', ap.phone || '']]);
    }
    B.details(groups);
    B.para(ZW.util.fill(s.warranty.intro, ctx), { size: 9, color: BODY, after: 1 });
    B.label('Warranty Coverage', { need: 26 }); B.para(ZW.util.fill(w.wording, ctx), { size: 9, color: INK, after: 2 });
    B.label('Terms & Conditions of Warranty', { need: 30 }); B.numbered(s.warranty.terms.filter((x) => String(x || '').trim()).map((x) => ({ body: ZW.util.fill(x, ctx) })));
    if (String(s.warranty.closing || '').trim()) { B.st.y += 2; B.para(ZW.util.fill(s.warranty.closing, ctx), { size: 9, color: BODY }); }
    await B.signatures(c, [{ label: 'Yours faithfully,', name: personName(c.authorizedPerson), sub: c.authorizedTitle, org: 'For ' + c.name, useSig: true }, { label: '', stamp: true, blankIfNone: true }], ...(() => { const saved = w.id && ZW.warrantyService.get(w.id); const src = saved ? saved : { stamp: c.stamp, stampX: c.stampX, stampY: c.stampY, stampSize: c.stampSize }; return [src.stamp || '', { dx: src.stampX, dy: src.stampY, scale: src.stampSize }]; })());
    B.finish(c, 'Warranty ' + w.number);
    return { doc: B.doc, filename: 'Warranty_' + w.number + '.pdf' };
  }

  const builders = { quotation: quotationPdf, invoice: invoicePdf, receipt: receiptPdf, warranty: warrantyPdf };
  let lastUrl = null;
  ZW.pdfService = {
    async build(kind, rec) {
      await ensureLibs(); const fn = builders[kind]; if (!fn) throw new ZW.AppError('Unknown document type.');
      let best = await fn(rec, 1); let n0 = best.doc.getNumberOfPages();
      for (const sp of [0.75, 0.5]) { if (n0 <= 1) break; const alt = await fn(rec, sp); const n = alt.doc.getNumberOfPages(); if (n < n0) { best = alt; break; } }
      const { doc, filename } = best;
      const pdfs = kind === 'quotation' ? (rec.pdfAttachments || []).filter((x) => x && x.data) : [];
      const blob = pdfs.length ? await appendPdfs(doc.output('arraybuffer'), pdfs) : doc.output('blob');
      return { blob, filename: filename.replace(/[^\w.\-]+/g, '_') };
    },
    async preview(kind, rec) { const out = await this.build(kind, rec); if (lastUrl) URL.revokeObjectURL(lastUrl); lastUrl = URL.createObjectURL(out.blob); return { url: lastUrl, filename: out.filename, blob: out.blob }; },
    async download(kind, rec, prebuilt) {
      const { blob, filename } = prebuilt || (await this.build(kind, rec));
      const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); return filename;
    },
    async share(kind, rec, prebuilt) {
      const out = prebuilt || (await this.build(kind, rec));
      const file = new File([out.blob], out.filename, { type: 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: out.filename }); return 'shared'; } catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
      }
      await this.download(kind, rec, out); return 'downloaded';
    },
  };
})();
