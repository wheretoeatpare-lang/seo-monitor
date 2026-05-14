const nodemailer = require("nodemailer");

class EmailReporter {
  constructor(from, to, password) {
    this.from = from;
    this.to = to;
    this.transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: from, pass: password },
    });
  }

  async sendReport({ changed, skipped, errors, runDate, siteUrl }) {
    const totalScanned = changed.length + skipped.length + errors.length;

    const changedRows = changed.map((p) => `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0">
          <a href="${p.url}" style="color:#534AB7;font-weight:500;text-decoration:none">${p.filePath}</a>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:13px">
          ${p.analysis.titleOk ? `<span style="color:#27500A">✓ OK</span>` : `
            <div style="color:#888;text-decoration:line-through;font-size:12px">${p.oldTitle}</div>
            <div style="color:#222;margin-top:4px">${p.analysis.newTitle}</div>
            <div style="color:#854F0B;font-size:11px;margin-top:2px">${p.analysis.reasonTitle}</div>
          `}
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:13px">
          ${p.analysis.metaOk ? `<span style="color:#27500A">✓ OK</span>` : `
            <div style="color:#888;text-decoration:line-through;font-size:12px">${p.oldMeta}</div>
            <div style="color:#222;margin-top:4px">${p.analysis.newMetaDesc}</div>
            <div style="color:#854F0B;font-size:11px;margin-top:2px">${p.analysis.reasonMeta}</div>
          `}
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:center">
          <span style="background:#EAF3DE;color:#27500A;padding:3px 10px;border-radius:99px;font-size:12px;font-weight:500">Updated</span>
        </td>
      </tr>`).join("");

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f6f5f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:900px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e8e6e0">

    <div style="background:#534AB7;padding:28px 32px;color:#fff">
      <div style="font-size:20px;font-weight:500;margin-bottom:4px">Daily SEO Monitor Report</div>
      <div style="font-size:14px;opacity:.8">${runDate} · ${siteUrl}</div>
    </div>

    <div style="display:flex;border-bottom:1px solid #f0f0f0">
      <div style="flex:1;padding:20px 24px;border-right:1px solid #f0f0f0;text-align:center">
        <div style="font-size:28px;font-weight:500;color:#534AB7">${totalScanned}</div>
        <div style="font-size:13px;color:#888;margin-top:4px">Pages scanned</div>
      </div>
      <div style="flex:1;padding:20px 24px;border-right:1px solid #f0f0f0;text-align:center">
        <div style="font-size:28px;font-weight:500;color:#27500A">${changed.length}</div>
        <div style="font-size:13px;color:#888;margin-top:4px">Pages updated</div>
      </div>
      <div style="flex:1;padding:20px 24px;border-right:1px solid #f0f0f0;text-align:center">
        <div style="font-size:28px;font-weight:500;color:#085041">${skipped.length}</div>
        <div style="font-size:13px;color:#888;margin-top:4px">Already good</div>
      </div>
      <div style="flex:1;padding:20px 24px;text-align:center">
        <div style="font-size:28px;font-weight:500;color:#A32D2D">${errors.length}</div>
        <div style="font-size:13px;color:#888;margin-top:4px">Errors</div>
      </div>
    </div>

    ${changed.length > 0 ? `
    <div style="padding:24px 32px 8px">
      <div style="font-size:15px;font-weight:500;color:#222;margin-bottom:4px">Pages updated</div>
      <div style="font-size:13px;color:#888;margin-bottom:16px">These pages had SEO issues — AI rewrote them and pushed changes to GitHub automatically.</div>
    </div>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#f6f5f1">
            <th style="padding:10px 12px;text-align:left;font-weight:500;color:#555;font-size:12px">Page</th>
            <th style="padding:10px 12px;text-align:left;font-weight:500;color:#555;font-size:12px">Title</th>
            <th style="padding:10px 12px;text-align:left;font-weight:500;color:#555;font-size:12px">Meta description</th>
            <th style="padding:10px 12px;text-align:center;font-weight:500;color:#555;font-size:12px">Status</th>
          </tr>
        </thead>
        <tbody>${changedRows}</tbody>
      </table>
    </div>` : `
    <div style="padding:32px;text-align:center;color:#27500A;font-size:15px">
      ✓ All pages have good SEO — nothing changed today!
    </div>`}

    ${errors.length > 0 ? `
    <div style="padding:20px 32px;background:#FCEBEB;border-top:1px solid #f09595">
      <div style="font-size:14px;font-weight:500;color:#A32D2D;margin-bottom:8px">Errors</div>
      ${errors.map(e => `<div style="font-size:13px;color:#791F1F;margin-bottom:4px">· ${e.file}: ${e.error}</div>`).join("")}
    </div>` : ""}

    <div style="padding:20px 32px;border-top:1px solid #f0f0f0;background:#f6f5f1">
      <div style="font-size:12px;color:#aaa;text-align:center">Daily SEO Monitor · Next run tomorrow morning · Changes are live on GitHub Pages</div>
    </div>
  </div>
</body>
</html>`;

    await this.transporter.sendMail({
      from: `"SEO Monitor Bot" <${this.from}>`,
      to: this.to,
      subject: `SEO Report: ${changed.length} pages updated, ${skipped.length} already good — ${runDate}`,
      html,
    });

    console.log(`  Email sent to ${this.to}`);
  }
}

module.exports = EmailReporter;
