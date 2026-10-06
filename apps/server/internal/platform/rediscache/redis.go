package rediscache

import (
	"context"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"gorm.io/gorm"

	"github.com/Moonrend/Zakura/apps/server/internal/platform/admin"
	"github.com/Moonrend/Zakura/apps/server/internal/platform/db/models"
)

const redisURLSettingKey = "infra.redis_url"

type silentLogger struct{}

func (silentLogger) Printf(context.Context, string, ...interface{}) {}

func init() {
	redis.SetLogger(silentLogger{})
}

type Cache struct {
	client *redis.Client
}

func Open(ctx context.Context, rawURL string) *Cache {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return &Cache{}
	}
	opt, err := redis.ParseURL(rawURL)
	if err != nil {
		return &Cache{}
	}
	client := redis.NewClient(opt)
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		return &Cache{}
	}
	return &Cache{client: client}
}

func (c *Cache) Get(ctx context.Context, key string) ([]byte, bool) {
	if c == nil || c.client == nil {
		return nil, false
	}
	value, err := c.client.Get(ctx, key).Bytes()
	if err != nil {
		return nil, false
	}
	return value, true
}

func (c *Cache) Set(ctx context.Context, key string, val []byte, ttl time.Duration) {
	if c == nil || c.client == nil {
		return
	}
	_ = c.client.Set(ctx, key, val, ttl).Err()
}

func (c *Cache) Del(ctx context.Context, key string) {
	if c == nil || c.client == nil {
		return
	}
	_ = c.client.Del(ctx, key).Err()
}

func (c *Cache) Enabled() bool {
	return c != nil && c.client != nil
}

func URLFromSettings(ctx context.Context, gormDB *gorm.DB, secret []byte) string {
	if gormDB == nil || len(secret) == 0 {
		return ""
	}
	var row models.Setting
	if err := gormDB.WithContext(ctx).Where("owner_key='platform' AND key=?", redisURLSettingKey).Take(&row).Error; err != nil {
		return ""
	}
	sealed := strings.TrimSpace(row.Value)
	if sealed == "" {
		return ""
	}
	plain, err := admin.OpenAdminValue(secret, sealed)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(plain)
}
