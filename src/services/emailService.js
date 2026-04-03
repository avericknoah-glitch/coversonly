const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendPasswordResetEmail(toEmail, resetToken, username) {
  const resetUrl = `https://coversonly-production.up.railway.app?reset=${resetToken}`;

  try {
    await resend.emails.send({
      from: 'Covers Only <onboarding@resend.dev>',
      to: toEmail,
      subject: 'Reset Your Covers Only Password',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;">
          <h1 style="color:#003D38;font-size:28px;margin-bottom:8px;">Covers Only</h1>
          <p style="color:#64748b;margin-bottom:24px;">Hey ${username},</p>
          <p>Someone requested a password reset for your account. Click the button below to set a new password:</p>
          <a href="${resetUrl}" style="display:inline-block;margin:24px 0;padding:14px 28px;background:#003D38;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;">Reset Password</a>
          <p style="color:#64748b;font-size:13px;">This link expires in 1 hour. If you didn't request this, ignore this email.</p>
        </div>
      `,
    });
    return true;
  } catch (err) {
    console.error('[EmailService] Failed to send reset email:', err.message);
    return false;
  }
}

module.exports = { sendPasswordResetEmail };
