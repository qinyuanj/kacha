package packservice

import "errors"

// errorsAs 是 errors.As 的薄封装：只为了在 run 里保持一行。
func errorsAs(err error, target any) bool { return errors.As(err, target) }
