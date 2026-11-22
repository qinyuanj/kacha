// 命令 feedbackrelay 是反馈中继的入口：读环境变量里的配置并起 HTTP 服务。
package main

import (
	"log"
	"net/http"
	"os"

	"github.com/qinyuanj/kacha/desktop/internal/feedbackrelay"
)

func main() {
	cfg, err := loadConfig(os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	svc := feedbackrelay.New(cfg)
	log.Printf("反馈中继监听 %s，写入 %s", cfg.Address, cfg.OwnerRepo)
	if err := http.ListenAndServe(cfg.Address, svc.Handler()); err != nil {
		log.Fatal(err)
	}
}

// loadConfig 只从环境变量读取运行参数；Gitea token 由每次反馈请求自带，服务端不读取也不保存。
func loadConfig(getenv func(string) string) (feedbackrelay.Config, error) {
	return feedbackrelay.Config{
		GiteaBase: envOr(getenv, "FEEDBACK_GITEA_URL", "http://lzxsvn:3000"),
		OwnerRepo: envOr(getenv, "FEEDBACK_GITEA_REPO", "qinyuanj/kacha-feedback"),
		Address:   envOr(getenv, "FEEDBACK_ADDR", ":3005"),
	}, nil
}

func envOr(getenv func(string) string, key, def string) string {
	if v := getenv(key); v != "" {
		return v
	}
	return def
}
