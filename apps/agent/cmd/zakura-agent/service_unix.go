//go:build !windows

package main

import "context"

func runService(_ func(context.Context)) (bool, error) { return false, nil }
