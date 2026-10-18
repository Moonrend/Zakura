package runtime

import (
	"time"

	"github.com/Moonrend/Zakura/apps/server/internal/computers"
	"gorm.io/gorm"
)

// ensureServerComputer guarantees, inside the Space's own transaction, that the
// Space has its server computer and refreshes the computer's cached workspace
// columns. It never touches a chat selection, a Run pin, a runtime or any
// attached computer, and it never contacts a runner.
func ensureServerComputer(tx *gorm.DB, tenant, space string) error {
	for _, statement := range computers.ServerComputerStatements(tenant, space, time.Now()) {
		if err := tx.Exec(statement.SQL, statement.Args...).Error; err != nil {
			return err
		}
	}
	return nil
}

// adoptLegacyComputer is the hook Store.CreateSpace and Store.UpdateSpace call
// in their transactions; it now ensures the Space server computer.
func adoptLegacyComputer(tx *gorm.DB, tenant, space string) error {
	return ensureServerComputer(tx, tenant, space)
}
