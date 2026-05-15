const { Resend } = require("resend");

class EmailReporter {
  constructor(from, to, apiKey) {
    this.from = from;
    this.to = to;
    this.resend = new Resend(apiKey);
  }

  async sendReport({ changed, rejected, skipped, errors, runDate, siteUrl }) {
    const totalScanned = changed.length + rejected.length + skipped.length + errors.length;

    const changedRows = changed.map((p) => `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0">
          <a href="${p.url}" style="color:#534AB7;font-weight:500;text-decoration:none">${p.filePath}</a>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:13px">
          ${p.analysis.titleOk ? `<span style="color:#27500A">✓ Already good</span>` : `
            <div style="color:#888;text-decoration:line-through;font-size:12px">${p.oldTitle}</div>
            <div style="color:#222;margin-top:4px;font-weight:500">${p.analysis.newTitle}</div>
            <div style="color:#854F0B;font-size:11px;margin-top:4px;padding:4px 8px;background:#FFF8E6;border-radius:4px">${p.analysis.reasonTitle}</div>
          `}
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:13px">
          ${p.analysis.metaOk ? `<span style="color:#27500A">✓ Already good</span>` : `
            <div style="color:#888;text-decoration:line-through;font-size:12px">${p.oldMeta}</div>
            <div style="color:#222;margin-top:4px;font-weight:500">${p.analysis.newMetaDesc}</div>
            <div style="color:#854F0B;font-size:11px;margin-top:4px;padding:4px 8px;background:#FFF8E6;border-radius:4px">${p.analysis.reasonMeta}</div>
          `}
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:center">
          <span style="background:#EAF3DE;color:#27500A;padding:3px 10px;border-radius:99px;font-size:12px;font-weight:500">✓ Applied</span>
        </td>
      </tr>`).join("");

    const rejectedRows = rejected.map((p) => `
      <tr style="opacity:0.7">
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0">
          <a href="${p.url}" style="color:#534AB7;font-weight:500;text-decoration:none">${p.filePath}</a>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:13px">
          ${p.analysis.titleOk ? `<span style="color:#27500A">✓ Was already good</span>` : `
            <div style="color:#888;font-size:12px">Suggested: <em>${p.analysis.newTitle}</em></div>
            <div style="color:#999;font-size:11px;margin-top:2px">${p.analysis.reasonTitle}</div>
          `}
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;font-size:13px">
          ${p.analysis.metaOk ? `<span style="color:#27500A">✓ Was already good</span>` : `
            <div style="color:#888;font-size:12px">Suggested: <em>${p.analysis.newMetaDesc}</em></div>
            <div style="color:#999;font-size:11px;margin-top:2px">${p.analysis.reasonMeta}</div>
          `}
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;text-align:center">
          <span style="background:#F5F5F5;color:#888;padding:3px 10px;border-radius:99px;font-size:12px;font-weight:500">Skipped</span>
        </td>
      </tr>`).join("");

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f6f5f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:900px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e8e6e0">

    <div style="background:#534AB7;padding:28px 32px;color:#fff">
      <div style="font-size:20px;font-weight:500;margin-bottom:4px">SEO Monitor Report — Changes Applied</div>
      <div style="font-size:14px;opacity:.8">${runDate} · ${siteUrl}</div>
    </div>

    <div style="display:flex;border-bottom:1px solid #f0f0f0">
      <div style="flex:1;padding:20px 24px;border-right:1px solid #f0f0f0;text-align:center">
        <div style="font-size:28px;font-weight:500;color:#534AB7">${totalScanned}</div>
        <div style="font-size:13px;color:#888;margin-top:4px">Pages scanned</div>
      </div>
      <div style="flex:1;padding:20px 24px;border-right:1px solid #f0f0f0;text-align:center">
        <div style="font-size:28px;font-weight:500;color:#27500A">${changed.length}</div>
        <div style="font-size:13px;color:#888;margin-top:4px">Changes applied</div>
      </div>
      <div style="flex:1;padding:20px 24px;border-right:1px solid #f0f0f0;text-align:center">
        <div style="font-size:28px;font-weight:500;color:#888">${rejected.length}</div>
        <div style="font-size:13px;color:#888;margin-top:4px">Suggestions skipped</div>
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
      <div style="font-size:15px;font-weight:500;color:#222;margin-bottom:4px">✅ Changes Applied to GitHub</div>
      <div style="font-size:13px;color:#888;margin-bottom:16px">These pages had SEO issues — you reviewed and approved AI suggestions. Changes are now live on GitHub.</div>
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
      ✓ No changes were applied this run.
    </div>`}

    ${rejected.length > 0 ? `
    <div style="padding:24px 32px 8px;margin-top:8px;border-top:1px solid #f0f0f0">
      <div style="font-size:15px;font-weight:500;color:#222;margin-bottom:4px">⏭ AI Suggestions You Skipped</div>
      <div style="font-size:13px;color:#888;margin-bottom:16px">These pages had AI suggestions but you chose not to apply them.</div>
    </div>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#f6f5f1">
            <th style="padding:10px 12px;text-align:left;font-weight:500;color:#555;font-size:12px">Page</th>
            <th style="padding:10px 12px;text-align:left;font-weight:500;color:#555;font-size:12px">Title Suggestion</th>
            <th style="padding:10px 12px;text-align:left;font-weight:500;color:#555;font-size:12px">Meta Suggestion</th>
            <th style="padding:10px 12px;text-align:center;font-weight:500;color:#555;font-size:12px">Status</th>
          </tr>
        </thead>
        <tbody>${rejectedRows}</tbody>
      </table>
    </div>` : ""}

    ${errors.length > 0 ? `
    <div style="padding:20px 32px;background:#FCEBEB;border-top:1px solid #f09595">
      <div style="font-size:14px;font-weight:500;color:#A32D2D;margin-bottom:8px">Errors</div>
      ${errors.map(e => `<div style="font-size:13px;color:#791F1F;margin-bottom:4px">· ${e.file}: ${e.error}</div>`).join("")}
    </div>` : ""}

    <div style="padding:20px 32px;border-top:1px solid #f0f0f0;background:#f6f5f1">
      <div style="font-size:12px;color:#aaa;text-align:center">SEO Monitor · Changes only apply after your approval · Powered by AI</div>
    </div>
  </div>
</body>
</html>`;

    console.log(`  [Email] Sending report via Resend to ${this.to}...`);
    try {
      const { data, error } = await this.resend.emails.send({
        from: `SEO Monitor Bot <${this.from}>`,
        to: this.to,
        subject: `SEO Report: ${changed.length} applied, ${rejected.length} skipped, ${skipped.length} already good — ${runDate}`,
        html,
      });

      if (error) {
        console.error("  [Email] Resend returned error:", JSON.stringify(error));
        throw new Error(error.message);
      }

      console.log("  [Email] ✓ Email sent successfully via Resend!");
      console.log("  [Email] Message ID:", data.id);
    } catch (err) {
      console.error("  [Email] Send FAILED:", err.message);
      throw err;
    }
  }
}

module.exports = EmailReporter;
