#!/bin/bash
# Sample workspace for the real-app gate and the README screenshot: a git repo with a main branch and uncommitted
# changes to the .proto files (for the breaking-change check), a file with errors, a messy file and a binary message.
# Usage: make-sample.sh <empty target dir>
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
t="$1"
mkdir -p "$t"
cd "$t"
mkdir -p proto/shop/v1 proto/common data
cp "$here/test/fixtures/shop/v1/shop.proto" proto/shop/v1/shop.proto
cp "$here/test/fixtures/common/money.proto" proto/common/money.proto
cp "$here/test/fixtures/route_guide.proto" proto/route_guide.proto
cp "$here/test/fixtures/order.bin" data/order.bin
git init -q -b main .
git -c user.name=Sample -c user.email=sample@example.com add -A
git -c user.name=Sample -c user.email=sample@example.com commit -q -m "shop api v1"
# working-tree changes against main: a renamed field, a removed field, a changed type, a removed enum value
sed -i.bak -e 's/string pickup_store = 7;/string store_id = 7;/' -e '/bytes signature = 11;/d' -e 's/sint64 balance = 10;/string balance = 10;/' -e '/STATUS_SHIPPED = 2;/d' proto/shop/v1/shop.proto
rm proto/shop/v1/shop.proto.bak
cat > proto/shop/v1/errors.proto <<'P'
syntax = "proto3";

package shop.v1;

import "common/money.proto";

message Refund {
  string order_id = 1;
  shop.common.Money amount = 2;
  string reason = 2;
  Customer customer = 3;
}

enum RefundState {
  REFUND_REQUESTED = 1;
  REFUND_DONE = 2;
}
P
cat > proto/shop/v1/messy.proto <<'P'
syntax="proto3";package shop.v1;
import  "common/money.proto" ;
// A gift card.
message GiftCard{string code=1;// printed on the card
 shop.common.Money balance = 2 ;repeated string   tags=3 [ deprecated=true ];
 map< string,string >labels=4;}
P
echo "sample ready in $t"
