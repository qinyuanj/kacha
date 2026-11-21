// 命令 feedbackrelay 是反馈中继的入口：读环境变量里的配置并起 HTTP 服务。
package main

import (
	"log"
	"net/http"
	"os"

	"github.com/qinyuanj/kacha/desktop/internal/feedbackrelay"
)

func main() {
	cfg := feedbackrelay.Config{
		GiteaBase: envOr("FEEDBACK_GITEA_URL", "http://lzxsvn:3000"),
		OwnerRepo: envOr("FEEDBACK_GITEA_REPO", "qinyuanj/kacha-feedback"),
		Token:     os.Getenv("FEEDBACK_GITEA_TOKEN"),
		Address:   envOr("FEEDBACK_ADDR", ":3005"),
	}
	if cfg.Token == "" {
		log.Fatal("缺少环境变量 FEEDBACK_GITEA_TOKEN")
	}
	svc := feedbackrelay.New(cfg)
	log.Printf("反馈中继监听 %s，写入 %s", cfg.Address, cfg.OwnerRepo)
	if err := http.ListenAndServe(cfg.Address, svc.Handler()); err != nil {
		log.Fatal(err)
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
