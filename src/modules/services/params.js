module.exports = class Params {
  constructor() {
    this.params = {};
  }

  setParams(params) {
    this.params = params;
  }

  set(key, value) {
    this.params[key] = value;
  }

  getParams() {
    return this.params;
  }

  get(key) {
    return this.params[key];
  }
};
