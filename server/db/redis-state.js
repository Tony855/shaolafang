let _client = null;
let _ready = false;
module.exports = {
  get client() { return _client; },
  set client(c) { _client = c; },
  get ready() { return _ready; },
  set ready(r) { _ready = r; },
};
