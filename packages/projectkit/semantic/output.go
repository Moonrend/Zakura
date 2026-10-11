package semantic

func resultLimit(limit int) int {
	if limit <= 0 {
		return 1000
	}
	if limit > 1000 {
		return 1000
	}
	return limit
}

// LimitFile bounds every returned collection without changing the cached index.
func LimitFile(f FileResult, limit int) FileResult {
	limit = resultLimit(limit)
	f.TotalSymbols = len(f.File.Symbols)
	f.TotalReferences = len(f.File.References)
	f.TotalImports = len(f.File.Imports)
	if len(f.File.Symbols) > limit {
		f.File.Symbols = f.File.Symbols[:limit]
		f.Truncated = true
	}
	if len(f.File.References) > limit {
		f.File.References = f.File.References[:limit]
		f.Truncated = true
	}
	if len(f.File.Imports) > limit {
		f.File.Imports = f.File.Imports[:limit]
		f.Truncated = true
	}
	if len(f.Dependencies) > limit {
		f.Dependencies = f.Dependencies[:limit]
		f.Truncated = true
	}
	if len(f.Dependents) > limit {
		f.Dependents = f.Dependents[:limit]
		f.Truncated = true
	}
	return f
}
func LimitComparison(c Comparison, limit int) Comparison {
	limit = resultLimit(limit)
	c.Counts = ComparisonCounts{Changes: len(c.Changes), APIChanges: len(c.APIChanges), Impacted: len(c.Impacted), RelatedTests: len(c.RelatedTests)}
	if len(c.Changes) > limit {
		c.Changes = c.Changes[:limit]
		c.Truncated = true
	}
	if len(c.APIChanges) > limit {
		c.APIChanges = c.APIChanges[:limit]
		c.Truncated = true
	}
	if len(c.Impacted) > limit {
		c.Impacted = c.Impacted[:limit]
		c.Truncated = true
	}
	if len(c.RelatedTests) > limit {
		c.RelatedTests = c.RelatedTests[:limit]
		c.Truncated = true
	}
	if c.Truncated {
		c.Complete = false
	}
	return c
}
