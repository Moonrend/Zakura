package emailtmpl

import (
	"strings"
	"testing"
)

func mustRender(t *testing.T, name string, data any) (string, string) {
	t.Helper()
	html, text, err := Render(name, data)
	if err != nil {
		t.Fatalf("render %s: %v", name, err)
	}
	return html, text
}

func assertContains(t *testing.T, label, body string, want ...string) {
	t.Helper()
	for _, w := range want {
		if !strings.Contains(body, w) {
			t.Fatalf("%s missing %q in:\n%s", label, w, body)
		}
	}
}

func TestRenderInvite(t *testing.T) {
	html, text := mustRender(t, Invite, InviteData{
		TenantName: "Acme",
		AcceptURL:  "https://app.example.com/invite/tok123",
		Role:       "admin",
	})
	assertContains(t, "invite html", html,
		"团队邀请",
		"邀请加入 Acme",
		"你被邀请以「管理员」加入 Acme。",
		"接受邀请",
		"https://app.example.com/invite/tok123",
		"链接 72 小时内有效。",
		"#0b57d0",
		"此邮件由系统自动发送，请勿直接回复。",
	)
	assertContains(t, "invite text", text,
		"你被邀请以「管理员」加入 Acme。",
		"接受邀请：https://app.example.com/invite/tok123",
		"链接 72 小时内有效。",
	)
}

func TestRenderVerifyEmail(t *testing.T) {
	html, text := mustRender(t, VerifyEmail, VerifyEmailData{
		VerifyURL: "https://app.example.com/verify-email?token=abc",
	})
	assertContains(t, "verify html", html,
		"验证邮箱",
		"验证你的 Zakura 邮箱",
		"链接 48 小时内有效。",
		"https://app.example.com/verify-email?token=abc",
		"#0b57d0",
		"此邮件由系统自动发送，请勿直接回复。",
	)
	assertContains(t, "verify text",
		text,
		"请验证你的 Zakura 邮箱。",
		"打开链接完成验证：https://app.example.com/verify-email?token=abc",
	)
}

func TestRenderResetPassword(t *testing.T) {
	html, text := mustRender(t, ResetPassword, ResetPasswordData{
		ResetURL: "https://app.example.com/reset-password?token=xyz",
	})
	assertContains(t, "reset html", html,
		"重置密码",
		"重置 Zakura 密码",
		"你请求重置密码。链接 1 小时内有效。",
		"https://app.example.com/reset-password?token=xyz",
		"#0b57d0",
	)
	assertContains(t, "reset text", text, "你正在重置 Zakura 密码。", "打开链接设置新密码：https://app.example.com/reset-password?token=xyz")

	setHTML, setText := mustRender(t, ResetPassword, ResetPasswordData{
		ResetURL:    "https://app.example.com/reset-password?token=xyz",
		SetPassword: true,
	})
	assertContains(t, "set password html", setHTML,
		"设置密码",
		"设置 Zakura 密码",
		"为你的 Zakura 账号设置密码。链接 1 小时内有效。",
		"https://app.example.com/reset-password?token=xyz",
	)
	assertContains(t, "set password text", setText, "为你的 Zakura 账号设置密码。", "打开链接设置密码：https://app.example.com/reset-password?token=xyz")
}

func TestRenderEmailCode(t *testing.T) {
	html, text := mustRender(t, EmailCode, EmailCodeData{Code: "123456"})
	assertContains(t, "email code html", html,
		"Zakura 登录验证码",
		"你的 Zakura 验证码是 <strong>123456</strong>。",
		"该验证码 10 分钟内有效，请勿泄露给他人。",
		"此邮件由系统自动发送，请勿直接回复。",
	)
	assertContains(t, "email code text", text, "你的 Zakura 验证码是 123456。", "该验证码 10 分钟内有效，请勿泄露给他人。")
}

func TestRenderCrisisSupport(t *testing.T) {
	html, text := mustRender(t, CrisisSupport, nil)
	assertContains(t, "crisis html", html,
		"Zakura支持资源",
		"400-161-9995",
		"tel:4001619995",
		"010-82951332",
		"tel:01082951332",
		"12320",
		"tel:12320",
		"https://www.iasp.info/suicidalthoughts/",
		"国际自杀预防协会",
		"珍重",
		"Zakura 支持",
		"#0b57d0",
		"此邮件由系统自动发送，请勿直接回复。",
	)
	assertContains(t, "crisis text", text,
		"400-161-9995",
		"010-82951332",
		"12320",
		"https://www.iasp.info/suicidalthoughts/",
		"珍重，",
		"Zakura 支持",
	)
}

func TestRenderEscapesUntrustedValues(t *testing.T) {
	html, text := mustRender(t, Invite, InviteData{
		TenantName: `<script>alert("x")</script>`,
		AcceptURL:  "https://app.example.com/invite/tok123",
		Role:       "member",
	})
	if strings.Contains(html, "<script>") {
		t.Fatalf("invite html did not escape tenant name:\n%s", html)
	}
	assertContains(t, "invite html escaped", html, "&lt;script&gt;")
	if !strings.Contains(text, `<script>alert("x")</script>`) {
		t.Fatalf("invite text should keep raw tenant name:\n%s", text)
	}
}

func TestRenderURLPreserved(t *testing.T) {
	raw := "https://app.example.com/verify-email?token=a&b=c"
	html, _ := mustRender(t, VerifyEmail, VerifyEmailData{VerifyURL: raw})
	assertContains(t, "verify url", html, `href="https://app.example.com/verify-email?token=a&amp;b=c"`)
}

func TestRenderUnknownTemplateFails(t *testing.T) {
	if _, _, err := Render("does_not_exist", nil); err == nil {
		t.Fatal("expected error for unknown template")
	}
}
