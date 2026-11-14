package localstore

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// sha256Hex 是文件字节的 sha256：测试自己算，不复用被测实现。
func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// 画板文件名与 Web 服务端口径一致：带扩展名；只剩 .bak 的孤儿也算一块；同一块只算一次。
func TestListBoardNamesReturnsBoardFileNames(t *testing.T) {
	s := New(t.TempDir())
	dir := s.BoardDir()
	if r := s.WriteBoard(filepath.Join(dir, "a"+BoardExt), "{}", WriteOptions{CreateOnly: true}); !r.OK {
		t.Fatalf("WriteBoard: %+v", r)
	}
	// 写两次留下 .bak，再删掉主文件：只剩 .bak 的孤儿也要列出来。
	if r := s.WriteBoard(filepath.Join(dir, "b"+BoardExt), "{}", WriteOptions{CreateOnly: true}); !r.OK {
		t.Fatalf("WriteBoard: %+v", r)
	}
	if r := s.WriteBoard(filepath.Join(dir, "b"+BoardExt), "{}", WriteOptions{}); !r.OK {
		t.Fatalf("WriteBoard: %+v", r)
	}
	if err := os.Remove(filepath.Join(dir, "b"+BoardExt)); err != nil {
		t.Fatalf("Remove: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "note.txt"), []byte("x"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	names, err := s.ListBoardNames(dir)
	if err != nil {
		t.Fatalf("ListBoardNames: %v", err)
	}
	want := []string{"a" + BoardExt, "b" + BoardExt}
	if len(names) != len(want) {
		t.Fatalf("names = %v, want %v", names, want)
	}
	for i, n := range names {
		if n != want[i] {
			t.Fatalf("names = %v, want %v", names, want)
		}
	}
}

// 目录不存在时列出空名单，不报错。
func TestListBoardNamesToleratesMissingDir(t *testing.T) {
	s := New(t.TempDir())
	names, err := s.ListBoardNames(filepath.Join(s.Root(), "none"))
	if err != nil {
		t.Fatalf("ListBoardNames: %v", err)
	}
	if len(names) != 0 {
		t.Fatalf("names = %v, want empty", names)
	}
}

// 画板列表的行：文件名带扩展名，路径是相对用户数据根的正斜杠路径。
func TestListReportsBoardFileNameAndRelativePath(t *testing.T) {
	s := New(t.TempDir())
	if r := s.WriteBoard(filepath.Join(s.BoardDir(), "一"+BoardExt), "{}", WriteOptions{CreateOnly: true}); !r.OK {
		t.Fatalf("WriteBoard: %+v", r)
	}

	listing, err := s.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(listing.Boards) != 1 {
		t.Fatalf("boards = %+v, want 1", listing.Boards)
	}
	if listing.Boards[0].Name != "一"+BoardExt {
		t.Fatalf("name = %q, want %q", listing.Boards[0].Name, "一"+BoardExt)
	}
	if listing.Boards[0].Path != "画板/一"+BoardExt {
		t.Fatalf("path = %q", listing.Boards[0].Path)
	}
	if listing.Slots.Used != 1 {
		t.Fatalf("slots = %+v, want used 1", listing.Slots)
	}
}

// 内容版本是主文件字节的 sha256：写入后算出来的版本要与文件字节一致。
func TestWriteVersionIsSha256OfFileBytes(t *testing.T) {
	s := New(t.TempDir())
	path := filepath.Join(s.BoardDir(), "画板"+BoardExt)
	text := "{\"format_version\": 2}"

	result := s.WriteBoard(path, text, WriteOptions{CreateOnly: true})
	if !result.OK {
		t.Fatalf("WriteBoard: %+v", result)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if result.Version != sha256Hex(data) {
		t.Fatalf("version = %q, want %q", result.Version, sha256Hex(data))
	}
	texts, err := s.ReadBoard(path)
	if err != nil {
		t.Fatalf("ReadBoard: %v", err)
	}
	if texts.Version == nil || *texts.Version != sha256Hex(data) {
		t.Fatalf("read version = %v, want %q", texts.Version, sha256Hex(data))
	}
	if texts.Main == nil || *texts.Main != text {
		t.Fatalf("main = %v", texts.Main)
	}
}

// 新建再读回来：内容原样，读到的版本与磁盘字节一致。
func TestCreateThenReadRoundTrip(t *testing.T) {
	s := New(t.TempDir())
	path := filepath.Join(s.BoardDir(), "画板"+BoardExt)
	text := "{\"format_version\":2,\"title\":\"本地\"}"

	if r := s.WriteBoard(path, text, WriteOptions{CreateOnly: true}); !r.OK {
		t.Fatalf("WriteBoard: %+v", r)
	}
	texts, err := s.ReadBoard(path)
	if err != nil {
		t.Fatalf("ReadBoard: %v", err)
	}
	if texts.Main == nil || *texts.Main != text {
		t.Fatalf("main = %v", texts.Main)
	}
	if texts.Version == nil || *texts.Version != sha256Hex([]byte(text)) {
		t.Fatalf("version = %v", texts.Version)
	}
}

// 只新建：主文件不在但 .bak 还在时也拒绝（Web 口径：孤儿 .bak 也占住名字）。
func TestWriteCreateOnlyRefusesOrphanBackup(t *testing.T) {
	s := New(t.TempDir())
	path := filepath.Join(s.BoardDir(), "画板"+BoardExt)
	if r := s.WriteBoard(path, "{}", WriteOptions{CreateOnly: true}); !r.OK {
		t.Fatalf("WriteBoard: %+v", r)
	}
	if r := s.WriteBoard(path, "{}", WriteOptions{}); !r.OK {
		t.Fatalf("WriteBoard: %+v", r)
	}
	if err := os.Remove(path); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	got := s.WriteBoard(path, "{}", WriteOptions{CreateOnly: true})
	if got.OK || got.Kind != KindAlreadyExist {
		t.Fatalf("result = %+v, want alreadyExists", got)
	}
}

// 带版本保存而画板已不在（被改名或删了）：拒绝，不凭空建出新画板。
func TestWriteWithVersionOnMissingBoardCreatesNothing(t *testing.T) {
	s := New(t.TempDir())
	path := filepath.Join(s.BoardDir(), "画板"+BoardExt)

	got := s.WriteBoard(path, "{}", WriteOptions{Version: "deadbeef"})
	if got.OK || got.Kind != KindMissing {
		t.Fatalf("result = %+v, want missing", got)
	}
	if s.IsFile(path) {
		t.Fatalf("不该凭空建出画板文件")
	}
}

// 写不进去时：旧内容逐字节不变，目录里不留临时文件，失败要带原因。
func TestWriteFailureKeepsOldContentByteForByteAndCleansTemp(t *testing.T) {
	s := New(t.TempDir())
	path := filepath.Join(s.BoardDir(), "画板"+BoardExt)
	old := "{\"title\":\"旧\"}"
	if r := s.WriteBoard(path, old, WriteOptions{CreateOnly: true}); !r.OK {
		t.Fatalf("WriteBoard: %+v", r)
	}
	// 目标文件只读：改名会被系统拒绝，保存因此失败。
	if err := os.Chmod(path, 0o444); err != nil {
		t.Fatalf("Chmod: %v", err)
	}
	defer os.Chmod(path, 0o644)

	got := s.WriteBoard(path, "{\"title\":\"新\"}", WriteOptions{})
	if got.OK {
		t.Fatalf("写只读文件应该失败：%+v", got)
	}
	if got.Kind != KindFailed {
		t.Fatalf("kind = %q, want %q", got.Kind, KindFailed)
	}
	if got.Message == "" {
		t.Fatalf("失败要带原因")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(data) != old {
		t.Fatalf("main = %q, want the old content kept byte for byte", string(data))
	}
	entries, err := os.ReadDir(s.BoardDir())
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Fatalf("临时文件留下了：%s", e.Name())
		}
	}
}

// 越出用户数据根的写入一律拒绝，根外不留下任何文件。
func TestWriteRejectsPathOutsideRoot(t *testing.T) {
	base := t.TempDir()
	s := New(filepath.Join(base, "root"))
	outside := filepath.Join(base, "outside"+BoardExt)

	got := s.WriteBoard(outside, "{}", WriteOptions{CreateOnly: true})
	if got.OK || got.Kind != KindInvalid {
		t.Fatalf("result = %+v, want invalid", got)
	}
	if _, err := os.Stat(outside); !os.IsNotExist(err) {
		t.Fatalf("越界文件不该被建出来：%v", err)
	}
}

// 改名与删除都认内容版本：内容已变就拒绝，画板还在原地。
func TestRenameAndRemoveRejectStaleVersion(t *testing.T) {
	s := New(t.TempDir())
	from := filepath.Join(s.BoardDir(), "一"+BoardExt)
	to := filepath.Join(s.BoardDir(), "二"+BoardExt)
	if r := s.WriteBoard(from, "{\"a\":1}", WriteOptions{CreateOnly: true}); !r.OK {
		t.Fatalf("WriteBoard: %+v", r)
	}
	texts, err := s.ReadBoard(from)
	if err != nil {
		t.Fatalf("ReadBoard: %v", err)
	}

	if got := s.RenameBoard(from, to, "deadbeef"); got.OK || got.Kind != KindConflict {
		t.Fatalf("rename result = %+v, want conflict", got)
	}
	if got := s.RemoveBoard(from, "deadbeef"); got.OK || got.Kind != KindConflict {
		t.Fatalf("remove result = %+v, want conflict", got)
	}
	if !s.IsFile(from) {
		t.Fatalf("画板不该被改名或删掉")
	}

	if got := s.RenameBoard(from, to, *texts.Version); !got.OK {
		t.Fatalf("RenameBoard: %+v", got)
	}
	if s.IsFile(from) {
		t.Fatalf("改名后原处不该再有画板")
	}
	if !s.IsFile(to) {
		t.Fatalf("改名后目标处要有画板")
	}
}

// 文件名由标题派生：去掉 Windows 非法字符与首尾空白、结尾的点与空格；空则用默认标题；
// Windows 保留名加下划线；重名加 " (2)"（不区分大小写）。
func TestBoardFileNameFollowsWindowsSafeRule(t *testing.T) {
	cases := []struct {
		title    string
		existing []string
		want     string
	}{
		{title: "本地画板", want: "本地画板" + BoardExt},
		{title: "角色/设定:<v2>?*\"|\\ ", want: "角色设定v2" + BoardExt},
		{title: "草稿..", want: "草稿" + BoardExt},
		{title: "///", want: DefaultBoardTitle + BoardExt},
		{title: "con", want: "con_" + BoardExt},
		{title: "本地画板", existing: []string{"本地画板" + BoardExt}, want: "本地画板 (2)" + BoardExt},
		{title: "Cat", existing: []string{"cat" + BoardExt, "Cat (2)" + BoardExt}, want: "Cat (3)" + BoardExt},
	}
	for _, c := range cases {
		if got := BoardFileName(c.title, c.existing); got != c.want {
			t.Fatalf("BoardFileName(%q, %v) = %q, want %q", c.title, c.existing, got, c.want)
		}
	}
}

// 新建画板：落在画板目录里，文件内容就是给的内容，版本是字节的 sha256。
func TestCreateBoardWritesNewBoard(t *testing.T) {
	s := New(t.TempDir())
	text := "{\"format_version\":2,\"title\":\"本地画板\"}"

	path, result := s.CreateBoard("本地画板", text)
	if !result.OK {
		t.Fatalf("CreateBoard: %+v", result)
	}
	if filepath.Dir(path) != s.BoardDir() {
		t.Fatalf("path = %q, want it under %q", path, s.BoardDir())
	}
	if filepath.Base(path) != "本地画板"+BoardExt {
		t.Fatalf("path = %q", path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(data) != text {
		t.Fatalf("content = %q", string(data))
	}
	if result.Version != sha256Hex(data) {
		t.Fatalf("version = %q, want %q", result.Version, sha256Hex(data))
	}
	texts, err := s.ReadBoard(path)
	if err != nil {
		t.Fatalf("ReadBoard: %v", err)
	}
	if texts.Main == nil || *texts.Main != text {
		t.Fatalf("main = %v", texts.Main)
	}
}

// 新建画板：同名再来一块，文件名加 " (2)"，两块都在。
func TestCreateBoardAvoidsExistingNames(t *testing.T) {
	s := New(t.TempDir())

	first, result := s.CreateBoard("本地画板", "{\"a\":1}")
	if !result.OK {
		t.Fatalf("CreateBoard: %+v", result)
	}
	second, result := s.CreateBoard("本地画板", "{\"a\":2}")
	if !result.OK {
		t.Fatalf("CreateBoard: %+v", result)
	}
	if filepath.Base(second) != "本地画板 (2)"+BoardExt {
		t.Fatalf("second = %q", second)
	}
	if first == second {
		t.Fatalf("两次新建落到了同一个文件")
	}
	for _, path := range []string{first, second} {
		if !s.IsFile(path) {
			t.Fatalf("画板没落盘：%s", path)
		}
	}
}

// 新建画板：不覆盖同名已有的画板（只新建）。
func TestCreateBoardNeverOverwrites(t *testing.T) {
	s := New(t.TempDir())
	path := filepath.Join(s.BoardDir(), "本地画板"+BoardExt)
	if r := s.WriteBoard(path, "{\"old\":1}", WriteOptions{CreateOnly: true}); !r.OK {
		t.Fatalf("WriteBoard: %+v", r)
	}

	created, result := s.CreateBoard("本地画板", "{\"new\":1}")
	if !result.OK {
		t.Fatalf("CreateBoard: %+v", result)
	}
	if created == path {
		t.Fatalf("新建覆盖了已有画板")
	}
	texts, err := s.ReadBoard(path)
	if err != nil {
		t.Fatalf("ReadBoard: %v", err)
	}
	if texts.Main == nil || *texts.Main != "{\"old\":1}" {
		t.Fatalf("旧画板内容被改了：%v", texts.Main)
	}
}

// 画板内容原样落盘：不认识的字段与节点类型原封不动（Go 侧不重写画板）。
func TestBoardContentKeepsUnknownFields(t *testing.T) {
	s := New(t.TempDir())
	path := filepath.Join(s.BoardDir(), "画板"+BoardExt)
	text := "{\"format_version\":2,\"title\":\"本地\",\"未来字段\":{\"x\":1},\"nodes\":[{\"id\":\"n\",\"type\":\"未来类型\",\"raw\":{\"a\":1}}]}"

	if r := s.WriteBoard(path, text, WriteOptions{CreateOnly: true}); !r.OK {
		t.Fatalf("WriteBoard: %+v", r)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(data) != text {
		t.Fatalf("content = %q, want it kept as is", string(data))
	}
}

// 默认标题与归档目录名与共享契约一致（两边各自定义，靠这条测试对齐）。
func TestPolicyNamesMatchSharedContract(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "contracts", "board-policy.json"))
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var policy struct {
		DefaultBoardTitle string `json:"default_board_title"`
		ArchiveDir        string `json:"archive_dir"`
	}
	if err := json.Unmarshal(data, &policy); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if policy.DefaultBoardTitle != DefaultBoardTitle {
		t.Fatalf("default title = %q, want %q", DefaultBoardTitle, policy.DefaultBoardTitle)
	}
	if policy.ArchiveDir != ArchiveDir {
		t.Fatalf("archive dir = %q, want %q", ArchiveDir, policy.ArchiveDir)
	}
}
