package main

import (
	"testing"
)

func envLookup(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestLoadConfigUsesEnvironmentDefaults(t *testing.T) {
	cfg, err := loadConfig(envLookup(nil))
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
}

func TestLoadConfigReadsEnvironmentOverrides(t *testing.T) {
	cfg, err := loadConfig(envLookup(map[string]string{
		"FEEDBACK_GITEA_URL":   "http://gitea.example:3000",
		"FEEDBACK_GITEA_REPO":  "team/feedback",
		"FEEDBACK_ADDR":        "127.0.0.1:4005",
	}))
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if cfg.GiteaBase != "http://gitea.example:3000" || cfg.OwnerRepo != "team/feedback" || cfg.Address != "127.0.0.1:4005" {
		t.Fatalf("cfg=%+v", cfg)
	}
}

func TestLoadConfigDoesNotReadLegacyTokenEnvironment(t *testing.T) {
	lookup := func(key string) string {
		if key == "FEEDBACK_GITEA_TOKEN" {
			t.Fatal("loadConfig read legacy token environment")
		}
		return ""
	}
	if _, err := loadConfig(lookup); err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
}

