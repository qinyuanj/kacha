package main

import (
	"strings"
	"testing"
)

func envLookup(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestLoadConfigUsesEnvironmentDefaults(t *testing.T) {
	cfg, err := loadConfig(envLookup(map[string]string{"FEEDBACK_GITEA_TOKEN": "runtime-token"}))
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if cfg.GiteaBase != "http://lzxsvn:3000" {
		t.Fatalf("GiteaBase=%q", cfg.GiteaBase)
	}
	if cfg.OwnerRepo != "qinyuanj/kacha-feedback" {
		t.Fatalf("OwnerRepo=%q", cfg.OwnerRepo)
	}
	if cfg.Address != ":3005" {
		t.Fatalf("Address=%q", cfg.Address)
	}
	if cfg.Token != "runtime-token" {
		t.Fatalf("Token=%q", cfg.Token)
	}
}

func TestLoadConfigReadsEnvironmentOverrides(t *testing.T) {
	cfg, err := loadConfig(envLookup(map[string]string{
		"FEEDBACK_GITEA_URL":   "http://gitea.example:3000",
		"FEEDBACK_GITEA_REPO":  "team/feedback",
		"FEEDBACK_GITEA_TOKEN": "runtime-token",
		"FEEDBACK_ADDR":        "127.0.0.1:4005",
	}))
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if cfg.GiteaBase != "http://gitea.example:3000" || cfg.OwnerRepo != "team/feedback" || cfg.Address != "127.0.0.1:4005" {
		t.Fatalf("cfg=%+v", cfg)
	}
}

func TestLoadConfigRequiresEnvironmentToken(t *testing.T) {
	_, err := loadConfig(envLookup(nil))
	if err == nil || !strings.Contains(err.Error(), "FEEDBACK_GITEA_TOKEN") {
		t.Fatalf("err=%v", err)
	}
}

func TestEnvOrUsesOverrideAndDefault(t *testing.T) {
	lookup := envLookup(map[string]string{"SET": "value"})
	if got := envOr(lookup, "SET", "fallback"); got != "value" {
		t.Fatalf("override=%q", got)
	}
	if got := envOr(lookup, "UNSET", "fallback"); got != "fallback" {
		t.Fatalf("default=%q", got)
	}
}
