/**
 * Freemail 主入口文件
 * @module server
 */

import { initDatabase, getInitializedDatabase } from './db/index.js';
import { createRouter, authMiddleware } from './routes/index.js';
import { createAssetManager } from './assets/index.js';
import { extractEmail } from './utils/common.js';
import { forwardByLocalPart, forwardByMailboxConfig } from './email/forwarder.js';
import { parseEmailBody, extractVerificationCode } from './email/parser.js';
import { getForwardTarget } from './db/mailboxes.js';

export default {
  async fetch(request, env, ctx) {
    let DB;
    try {
      DB = await getInitializedDatabase(env);
    } catch (error) {
      console.error('数据库连接失败:', error.message);
      return new Response('数据库连接失败，请检查配置', { status: 500 });
    }

    const MAIL_DOMAINS = (env.MAIL_DOMAIN || 'temp.example.com')
      .split(/[,\s]+/)
      .map(d => d.trim())
      .filter(Boolean);

    const router = createRouter();
    router.use(authMiddleware);

    const routeResponse = await router.handle(request, { request, env, ctx });
    if (routeResponse) return routeResponse;

    const assetManager = createAssetManager();
    return await assetManager.handleAssetRequest(request, env, MAIL_DOMAINS);
  },

  async email(message, env, ctx) {
    try {
      await env.TEMP_MAIL_DB.prepare(
        "INSERT INTO debug_events (stage, detail) VALUES (?, ?)"
      ).bind("email_enter", "worker email event triggered").run();
    } catch (_) {}

    let DB;
    try {
      DB = await getInitializedDatabase(env);
      try {
        await env.TEMP_MAIL_DB.prepare(
          "INSERT INTO debug_events (stage, detail) VALUES (?, ?)"
        ).bind("email_db_ok", "database connected").run();
      } catch (_) {}
    } catch (error) {
      try {
        await env.TEMP_MAIL_DB.prepare(
          "INSERT INTO debug_events (stage, detail) VALUES (?, ?)"
        ).bind("email_db_error", String(error && error.stack ? error.stack : error)).run();
      } catch (_) {}
      console.error('邮件处理时数据库连接失败:', error.message);
      return;
    }

    try {
      const headers = message.headers;
      const toHeader = headers.get('to') || headers.get('To') || '';
      const fromHeader = headers.get('from') || headers.get('From') || '';
      const subject = headers.get('subject') || headers.get('Subject') || '(无主题)';

      try {
        await env.TEMP_MAIL_DB.prepare(
          "INSERT INTO debug_events (stage, detail) VALUES (?, ?)"
        ).bind("email_headers_ok", JSON.stringify({ toHeader, fromHeader, subject }).slice(0, 1000)).run();
      } catch (_) {}

      let envelopeTo = '';
      try {
        const toValue = message.to;
        if (Array.isArray(toValue) && toValue.length > 0) {
          envelopeTo = typeof toValue[0] === 'string' ? toValue[0] : (toValue[0].address || '');
        } else if (typeof toValue === 'string') {
          envelopeTo = toValue;
        }
      } catch (_) {}

      const resolvedRecipient = (envelopeTo || toHeader || '').toString();
      const resolvedRecipientAddr = extractEmail(resolvedRecipient);
      const localPart = (resolvedRecipientAddr.split('@')[0] || '').toLowerCase();

      try {
        await env.TEMP_MAIL_DB.prepare(
          "INSERT INTO debug_events (stage, detail) VALUES (?, ?)"
        ).bind("email_recipient_resolved", JSON.stringify({ envelopeTo, resolvedRecipient, resolvedRecipientAddr, localPart }).slice(0, 1000)).run();
      } catch (_) {}

      const mailboxForwardTo = await getForwardTarget(DB, resolvedRecipientAddr);
      if (mailboxForwardTo) {
        forwardByMailboxConfig(message, mailboxForwardTo, ctx);
      } else {
        forwardByLocalPart(message, localPart, ctx, env);
      }

      let textContent = '';
      let htmlContent = '';
      try {
        const resp = new Response(message.raw);
        const rawBuffer = await resp.arrayBuffer();
        const rawText = await new Response(rawBuffer).text();
        const parsed = parseEmailBody(rawText);
        textContent = parsed.text || '';
        htmlContent = parsed.html || '';
        if (!textContent && !htmlContent) textContent = (rawText || '').slice(0, 100000);
      } catch (_) {
        textContent = '';
        htmlContent = '';
      }

      const mailbox = extractEmail(resolvedRecipient || toHeader);
      const sender = extractEmail(fromHeader);

      try {
        await env.TEMP_MAIL_DB.prepare(
          "INSERT INTO debug_events (stage, detail) VALUES (?, ?)"
        ).bind("email_mailbox_sender", JSON.stringify({ mailbox, sender }).slice(0, 1000)).run();
      } catch (_) {}

      const objectKey = '';
      const r2Bucket = 'mail-eml';

      const preview = (() => {
        const plain = textContent && textContent.trim()
          ? textContent
          : (htmlContent || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        return String(plain || '').slice(0, 120);
      })();

      let verificationCode = '';
      try {
        verificationCode = extractVerificationCode({ subject, text: textContent, html: htmlContent });
      } catch (_) {}

      try {
        await env.TEMP_MAIL_DB.prepare(
          "INSERT INTO debug_events (stage, detail) VALUES (?, ?)"
        ).bind("email_preview_code", JSON.stringify({ preview, verificationCode }).slice(0, 1000)).run();
      } catch (_) {}

      const resMb = await DB.prepare('SELECT id FROM mailboxes WHERE address = ?').bind(mailbox.toLowerCase()).all();
      let mailboxId;
      if (Array.isArray(resMb?.results) && resMb.results.length) {
        mailboxId = resMb.results[0].id;
      } else {
        const [localPartMb, domain] = (mailbox || '').toLowerCase().split('@');
        if (localPartMb && domain) {
          await DB.prepare('INSERT INTO mailboxes (address, local_part, domain, password_hash, last_accessed_at) VALUES (?, ?, ?, NULL, CURRENT_TIMESTAMP)')
            .bind((mailbox || '').toLowerCase(), localPartMb, domain).run();
          const created = await DB.prepare('SELECT id FROM mailboxes WHERE address = ?').bind((mailbox || '').toLowerCase()).all();
          mailboxId = created?.results?.[0]?.id;
        }
      }
      if (!mailboxId) throw new Error('无法解析或创建 mailbox 记录');

      try {
        await env.TEMP_MAIL_DB.prepare(
          "INSERT INTO debug_events (stage, detail) VALUES (?, ?)"
        ).bind("email_mailbox_id_ok", JSON.stringify({ mailbox, mailboxId }).slice(0, 1000)).run();
      } catch (_) {}

      let toAddrs = '';
      try {
        const toValue = message.to;
        if (Array.isArray(toValue)) {
          toAddrs = toValue.map(v => (typeof v === 'string' ? v : (v?.address || ''))).filter(Boolean).join(',');
        } else if (typeof toValue === 'string') {
          toAddrs = toValue;
        } else {
          toAddrs = resolvedRecipient || toHeader || '';
        }
      } catch (_) {
        toAddrs = resolvedRecipient || toHeader || '';
      }

      try {
        await env.TEMP_MAIL_DB.prepare(
          "INSERT INTO debug_events (stage, detail) VALUES (?, ?)"
        ).bind("email_before_insert", JSON.stringify({ mailboxId, sender, toAddrs, subject }).slice(0, 1000)).run();
      } catch (_) {}

      await DB.prepare(`
        INSERT INTO messages (mailbox_id, sender, to_addrs, subject, verification_code, preview, r2_bucket, r2_object_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        mailboxId,
        sender,
        String(toAddrs || ''),
        subject || '(无主题)',
        verificationCode || null,
        preview || null,
        r2Bucket,
        objectKey
      ).run();

      try {
        await env.TEMP_MAIL_DB.prepare(
          "INSERT INTO debug_events (stage, detail) VALUES (?, ?)"
        ).bind("email_insert_success", JSON.stringify({ mailbox, mailboxId, subject }).slice(0, 1000)).run();
      } catch (_) {}
    } catch (err) {
      try {
        await env.TEMP_MAIL_DB.prepare(
          "INSERT INTO debug_events (stage, detail) VALUES (?, ?)"
        ).bind("email_error", String(err && err.stack ? err.stack : err)).run();
      } catch (_) {}
      console.error('Email event handling error:', err);
    }
  }
};
