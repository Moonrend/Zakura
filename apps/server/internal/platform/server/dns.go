package server

import (
	"context"
	"errors"
	"net"
)

func VerifyDNSDomain(ctx context.Context, domain, token string) error {
	records, err := net.DefaultResolver.LookupTXT(ctx, "_zakura-verify."+domain)
	if err != nil {
		return err
	}
	for _, record := range records {
		if record == token || record == "zakura-verify="+token {
			return nil
		}
	}
	return errors.New("verification TXT record not found")
}
