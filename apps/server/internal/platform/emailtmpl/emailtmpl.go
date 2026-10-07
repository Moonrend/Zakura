package emailtmpl

import (
	"bytes"
	"embed"
	htemplate "html/template"
	ttemplate "text/template"
)

//go:embed templates
var templateFS embed.FS

const (
	Invite        = "invite"
	VerifyEmail   = "verify_email"
	ResetPassword = "reset_password"
	EmailCode     = "email_code"
	CrisisSupport = "crisis_support"
)

type InviteData struct {
	TenantName string
	AcceptURL  string
	Role       string
}

func (d InviteData) emailTitle() string   { return "团队邀请" }
func (d InviteData) emailPreview() string { return "邀请加入 " + d.TenantName }

type VerifyEmailData struct {
	VerifyURL string
}

func (d VerifyEmailData) emailTitle() string   { return "验证邮箱" }
func (d VerifyEmailData) emailPreview() string { return "验证你的 Zakura 邮箱" }

type ResetPasswordData struct {
	ResetURL    string
	SetPassword bool
}

func (d ResetPasswordData) emailTitle() string {
	if d.SetPassword {
		return "设置密码"
	}
	return "重置密码"
}

func (d ResetPasswordData) emailPreview() string {
	if d.SetPassword {
		return "设置 Zakura 密码"
	}
	return "重置 Zakura 密码"
}

type EmailCodeData struct {
	Code string
}

func (d EmailCodeData) emailTitle() string   { return "Zakura 登录验证码" }
func (d EmailCodeData) emailPreview() string { return "Zakura 登录验证码" }

type accountEmail interface {
	emailTitle() string
	emailPreview() string
}

type envelope struct {
	Title   string
	Preview string
	Data    any
}

var htmlFuncs = htemplate.FuncMap{
	"safeURL": func(raw string) htemplate.URL { return htemplate.URL(raw) },
	"roleLabel": func(role string) string {
		switch role {
		case "admin":
			return "管理员"
		case "member":
			return "成员"
		default:
			return role
		}
	},
}

var textFuncs = ttemplate.FuncMap{
	"roleLabel": func(role string) string {
		switch role {
		case "admin":
			return "管理员"
		case "member":
			return "成员"
		default:
			return role
		}
	},
}

func Render(name string, data any) (string, string, error) {
	entry := name
	htmlData := data
	if account, ok := data.(accountEmail); ok {
		entry = "account_layout"
		htmlData = envelope{Title: account.emailTitle(), Preview: account.emailPreview(), Data: data}
	}

	htmlTmpl, err := htemplate.New(name).Funcs(htmlFuncs).ParseFS(templateFS, "templates/layout.gohtml", "templates/"+name+".gohtml")
	if err != nil {
		return "", "", err
	}
	var htmlBody bytes.Buffer
	if err := htmlTmpl.ExecuteTemplate(&htmlBody, entry, htmlData); err != nil {
		return "", "", err
	}

	textTmpl, err := ttemplate.New(name).Funcs(textFuncs).ParseFS(templateFS, "templates/"+name+".txt")
	if err != nil {
		return "", "", err
	}
	var textBody bytes.Buffer
	if err := textTmpl.ExecuteTemplate(&textBody, name+".txt", data); err != nil {
		return "", "", err
	}

	return htmlBody.String(), textBody.String(), nil
}
