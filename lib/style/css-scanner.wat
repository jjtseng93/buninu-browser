;; Scan UTF-16 code units, returning indices into the original JavaScript string.
;; mode 0 finds a closing brace; 59/123 a semicolon/open brace; 1 either rule delimiter.
(module
  (memory (export "memory") 1 128) ;; 8 MiB limit, including one vector of padding
  (func (export "scan") (param $i i32) (param $end i32) (param $mode i32) (result i32)
    (local $base i32) (local $mask i32) (local $pos i32) (local $c i32)
    (local $depth i32) (local $quote i32) (local $skip i32) (local $data v128)
    (block $done (loop $chunks
      (br_if $done (i32.ge_u (local.get $i) (local.get $end)))
      (local.set $base (i32.shl (local.get $i) (i32.const 1)))
      ;; Narrow sixteen lanes for an ASCII delimiter mask. A non-ASCII code
      ;; unit saturates or remains non-ASCII, so cannot resemble a delimiter.
      (local.set $data (i8x16.narrow_i16x8_u
        (v128.load (local.get $base)) (v128.load offset=16 (local.get $base))))
      (local.set $mask (i8x16.bitmask (v128.or
        (v128.or (i8x16.eq (local.get $data) (i8x16.splat (i32.const 34)))
                 (i8x16.eq (local.get $data) (i8x16.splat (i32.const 39))))
        (v128.or (i8x16.eq (local.get $data) (i8x16.splat (i32.const 92)))
          (v128.or (i8x16.eq (local.get $data) (i8x16.splat (i32.const 123)))
                   (i8x16.eq (local.get $data) (i8x16.splat (i32.const 125))))))))
      (if (local.get $mode) (then
        (local.set $mask (i32.or (local.get $mask) (i8x16.bitmask (v128.or
          (i8x16.eq (local.get $data) (i8x16.splat (i32.const 40)))
          (v128.or (i8x16.eq (local.get $data) (i8x16.splat (i32.const 41)))
                   (i8x16.eq (local.get $data) (i8x16.splat (i32.const 59))))))))))
      ;; Visit set bits in order. Quotes, escapes and nesting survive across
      ;; vectors. Bytes past end are readable padding and never produce a hit.
      (block $next (loop $bits
        (br_if $next (i32.eqz (local.get $mask)))
        (local.set $pos (i32.add (local.get $i) (i32.ctz (local.get $mask))))
        (local.set $mask (i32.and (local.get $mask) (i32.sub (local.get $mask) (i32.const 1))))
        (br_if $done (i32.ge_u (local.get $pos) (local.get $end)))
        (br_if $bits (i32.lt_u (local.get $pos) (local.get $skip)))
        (local.set $c (i32.load16_u (i32.shl (local.get $pos) (i32.const 1))))
        (if (i32.eq (local.get $c) (i32.const 92)) (then
          (local.set $skip (i32.add (local.get $pos) (i32.const 2))) (br $bits)))
        (if (local.get $quote) (then
          (if (i32.eq (local.get $c) (local.get $quote)) (then (local.set $quote (i32.const 0)))) (br $bits)))
        (if (i32.or (i32.eq (local.get $c) (i32.const 34)) (i32.eq (local.get $c) (i32.const 39)))
          (then (local.set $quote (local.get $c)) (br $bits)))
        (if (i32.eqz (local.get $mode)) (then
          (if (i32.eq (local.get $c) (i32.const 123))
            (then (local.set $depth (i32.add (local.get $depth) (i32.const 1))))
            (else (local.set $depth (i32.sub (local.get $depth) (i32.const 1)))
              (if (i32.eqz (local.get $depth)) (then (return (local.get $pos)))))))
        (else
          (if (i32.eq (local.get $c) (i32.const 40)) (then
            (local.set $depth (i32.add (local.get $depth) (i32.const 1))) (br $bits)))
          (if (i32.eq (local.get $c) (i32.const 41)) (then
            (if (local.get $depth) (then (local.set $depth (i32.sub (local.get $depth) (i32.const 1))))) (br $bits)))
          (if (i32.and (i32.eq (local.get $c) (i32.const 59)) (i32.eqz (local.get $depth)))
            (then (if (i32.ne (local.get $mode) (i32.const 123)) (then (return (local.get $pos))))))
          (if (i32.ge_u (local.get $c) (i32.const 123)) (then
            (return (select (local.get $pos) (i32.const -1)
              (i32.and (i32.eq (local.get $c) (i32.const 123))
                       (i32.ne (local.get $mode) (i32.const 59)))))))))
        (br $bits)))
      (local.set $i (i32.add (local.get $i) (i32.const 16))) (br $chunks)))
    (select (i32.const -1) (local.get $end) (local.get $mode))))
