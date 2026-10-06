package main

import (
	"context"

	"golang.org/x/sys/windows/svc"
	"zakura.dev/agent/internal/sys"
)

// The installer registers a real SCM service. A plain console main does not
// implement its start/stop protocol and cannot be restarted by Start-Service.
func runService(run func(context.Context)) (bool, error) {
	isService, err := svc.IsWindowsService()
	if err != nil || !isService {
		return false, err
	}
	return true, svc.Run(sys.WindowsService, &agentService{run: run})
}

type agentService struct{ run func(context.Context) }

func (s *agentService) Execute(_ []string, requests <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	changes <- svc.Status{State: svc.StartPending}
	done := make(chan struct{})
	go func() { defer close(done); s.run(ctx) }()
	changes <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case <-done:
			return false, 0
		case request := <-requests:
			switch request.Cmd {
			case svc.Interrogate:
				changes <- request.CurrentStatus
			case svc.Stop, svc.Shutdown:
				changes <- svc.Status{State: svc.StopPending}
				cancel()
				<-done
				return false, 0
			}
		}
	}
}
