package feedbackservice

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"strings"
)

// metadata 是写进 issue 正文的上下文；不写任何密钥。
type metadata struct {
	version   string
	build     string
	os        string
	boardName string
	contact   string
}

func composeBody(body string, m metadata) string {
	var b strings.Builder
	b.WriteString(body)
	b.WriteString("\n\n---\n\n")
	if m.version != "" {
		b.WriteString("- 版本：" + m.version)
		if m.build != "" {
			b.WriteString(" (" + m.build + ")")
		}
		b.WriteString("\n")
	}
	if m.os != "" {
		b.WriteString("- 系统：" + m.os + "\n")
	}
	if m.boardName != "" {
		b.WriteString("- 画板：" + m.boardName + "\n")
	}
	if m.contact != "" {
		b.WriteString("- 提交者：" + m.contact + "\n")
	} else {
		b.WriteString("- 提交者：匿名\n")
	}
	b.WriteString("\n_由 Kacha 直接提交_")
	return b.String()
}

// giteaStatusError 只保留状态码，不携带响应体或请求头，避免把凭据带进错误链。
type giteaStatusError struct{ status int }

func (e *giteaStatusError) Error() string { return fmt.Sprintf("Gitea 返回 %d", e.status) }

func outcomeForError(err error) Outcome {
	var statusErr *giteaStatusError
	if errors.As(err, &statusErr) {
		switch statusErr.status {
		case http.StatusUnauthorized, http.StatusForbidden:
			return Outcome{Kind: KindUnauthorized, Message: MessageUnauthorized}
		case http.StatusBadRequest, http.StatusUnprocessableEntity:
			return Outcome{Kind: KindInvalid, Message: MessageInvalid}
		case http.StatusRequestEntityTooLarge:
			return Outcome{Kind: KindTooLarge, Message: MessageTooLarge}
		default:
			return Outcome{Kind: KindRejected, Message: MessageRejected}
		}
	}
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		return Outcome{Kind: KindUnreachable, Message: MessageUnreachable}
	}
	return Outcome{Kind: KindRejected, Message: MessageRejected}
}

type createdIssue struct {
	Number  int    `json:"number"`
	HTMLURL string `json:"html_url"`
}

func (s *Service) apiURL(path string) string {
	return strings.TrimRight(s.cfg.GiteaBase, "/") + "/api/v1" + path
}

func (s *Service) doJSON(method, path, token string, in any, out any) error {
	var body io.Reader
	if in != nil {
		raw, _ := json.Marshal(in)
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, s.apiURL(path), body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "token "+token)
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("请求 Gitea 失败：%w", err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &giteaStatusError{status: resp.StatusCode}
	}
	if out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("解析 Gitea 响应失败：%w", err)
		}
	}
	return nil
}

func (s *Service) createIssue(title, body, category, token string) (createdIssue, error) {
	opt := map[string]any{"title": title, "body": body}
	if ids := s.labelIDs(category, token); len(ids) > 0 {
		opt["labels"] = ids
	}
	var out createdIssue
	err := s.doJSON(http.MethodPost, fmt.Sprintf("/repos/%s/issues", s.cfg.OwnerRepo), token, opt, &out)
	return out, err
}

func (s *Service) patchIssue(number int, body, token string) error {
	return s.doJSON(http.MethodPatch, fmt.Sprintf("/repos/%s/issues/%d", s.cfg.OwnerRepo, number), token, map[string]string{"body": body}, nil)
}

// labelIDs 取分类与来源标签；标签不可读时仍尝试创建 issue，不伪造标签写入成功。
func (s *Service) labelIDs(category, token string) []int64 {
	var rows []struct {
		ID   int64  `json:"id"`
		Name string `json:"name"`
	}
	if err := s.doJSON(http.MethodGet, fmt.Sprintf("/repos/%s/labels?limit=50", s.cfg.OwnerRepo), token, nil, &rows); err != nil {
		return nil
	}
	byName := map[string]int64{}
	for _, row := range rows {
		byName[row.Name] = row.ID
	}
	var ids []int64
	for _, name := range []string{"type/" + category, "source/app"} {
		if id := byName[name]; id != 0 {
			ids = append(ids, id)
		}
	}
	return ids
}

// uploadAsset 把一张附件挂到 issue 上；字段名是 Gitea 的 attachment，文件名走 query name。
func (s *Service) uploadAsset(number int, attachment Attachment, token string) (string, error) {
	var buf bytes.Buffer
	writer := multipart.NewWriter(&buf)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", fmt.Sprintf("form-data; name=%q; filename=%q", "attachment", attachment.Name))
	header.Set("Content-Type", attachment.ContentType)
	part, err := writer.CreatePart(header)
	if err != nil {
		return "", err
	}
	if _, err := part.Write(attachment.Data); err != nil {
		return "", err
	}
	if err := writer.Close(); err != nil {
		return "", err
	}

	address := s.apiURL(fmt.Sprintf("/repos/%s/issues/%d/assets", s.cfg.OwnerRepo, number)) + "?name=" + url.QueryEscape(attachment.Name)
	req, err := http.NewRequest(http.MethodPost, address, &buf)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "token "+token)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	resp, err := s.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("上传附件失败：%w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", &giteaStatusError{status: resp.StatusCode}
	}
	var out struct {
		BrowserDownloadURL string `json:"browser_download_url"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("解析 Gitea 附件响应失败：%w", err)
	}
	return out.BrowserDownloadURL, nil
}
