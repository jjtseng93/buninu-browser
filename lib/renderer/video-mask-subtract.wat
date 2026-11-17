(module
  (memory (export "memory") 2 2)
  ;; First 64 KiB contains white pixels; next 64 KiB contains black.
  ;; Return the unsigned saturating difference in the first half.
  (func (export "subtract") (param $n i32)
    (local $i i32) (local $d i32)
    (block $tail
      (loop $next
        (br_if $tail (i32.gt_u (i32.add (local.get $i) (i32.const 16)) (local.get $n)))
        (v128.store (local.get $i)
          (i8x16.sub_sat_u
            (v128.load (local.get $i))
            (v128.load offset=65536 (local.get $i))))
        (local.set $i (i32.add (local.get $i) (i32.const 16)))
        (br $next)))
    (block $done
      (loop $last
        (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $d (i32.sub (i32.load8_u (local.get $i)) (i32.load8_u offset=65536 (local.get $i))))
        (i32.store8 (local.get $i) (select (local.get $d) (i32.const 0) (i32.gt_s (local.get $d) (i32.const 0))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $last)))))
