'use strict';

const { Device } = require('homey');
const Bond = require('../../lib/bond');

function hasProperties(obj, props) {
  if (!obj) return false;
  return props.every(prop => obj.hasOwnProperty(prop));
}

class FanDevice extends Device {

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {

    this.bond = new Bond(
      this.getSetting('ipAddress'),
      this.getSetting('token'),
      this.log
    );

    if (this.bond.isIpAddressValid() && this.bond.isTokenValid()) {
      const response = await this.driver.checkSettings(this.getSetting('ipAddress'), this.getSetting('token'));
      if (response.status === Bond.VALID_TOKEN) {

        await this.initialize();

        this.homey.setTimeout(async () => {
          /// get device state
          await this.getDeviceState();
        }, this.getRandomNumber(750, 1750));


        /// now poll every 10 sec for current state
        this.pollingId = this.homey.setInterval(async () => {
          await this.getDeviceState();
        }, 10000);
        await this.setAvailable();
      } else {
        this.log(`FanDevice initialization skipped due to invalid settings status=${response.status}`);
        await this.setUnavailable(response.status || 'INVALID SETTINGS');
      }
    }
  }

  getRandomNumber(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  async onUninit() {
    this.homey.clearInterval(this.pollingId);
  }

  async getDeviceState() {
    const state = await this.bond.getBondDeviceState(this.getData().id);
    if (state.status === Bond.OKAY) this.updateCapabilityValues(state);
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    if (changedKeys.includes("ipAddress") || changedKeys.includes("token")) {
      if (!this.bond.checkValidIpAddress(newSettings.ipAddress)) throw new Error("INVALID IP ADDRESS");
      if (this.bond.isEmptyOrUndefined(newSettings.token)) throw new Error("INVALID TOKEN");
      const response = await this.driver.checkSettings(newSettings.ipAddress, newSettings.token);
      if (response.status != Bond.VALID_TOKEN) {
        throw new Error(response.status);
      } else {

        this.bond = new Bond(
          newSettings.ipAddress,
          newSettings.token,
          this.log
        );
        return super.onSettings({ oldSettings, newSettings, changedKeys });
      }
    }
  }

  async initialize() {
    this.props = await this.bond.getBondDeviceProperties(this.getData().id);
    this.log(`FanDevice has been initialized props=${JSON.stringify(this.props)}`);

    if (hasProperties(this.props.data, ["feature_light"]) && this.props.data.feature_light) {
      // fan with light   
      this.registerCapabilityListener("onoff", async (value) => {
        if (value) {
          await this.bond.sendBondAction(this.getData().id, "TurnLightOn", {});
        } else {
          await this.bond.sendBondAction(this.getData().id, "TurnLightOff", {});
        }
      });

      if (hasProperties(this.props.data, ["feature_brightness"]) && this.props.data.feature_brightness) {
        // fan with light that dims
        await this.addCapability("dim");
        this.registerCapabilityListener("dim", async (value) => {
          await this.bond.sendBondAction(this.getData().id, "SetBrightness", { "argument": value * 100 });
        });
      } else {
        await this.removeCapability("dim");
      }
    } else {
      // basic fan (no light)
      await this.removeCapability("dim");
      this.registerCapabilityListener("onoff", async (value) => {
        if (value) {
          await this.bond.sendBondAction(this.getData().id, "TurnOn", {});
        } else {
          await this.bond.sendBondAction(this.getData().id, "TurnOff", {});
        }
      });
    }

    if (hasProperties(this.props.data, ["max_speed"])) {
      // fan with max_speed 
      await this.addCapability("fan_speed");
      await this.setCapabilityOptions("fan_speed", {
        min: 0,
        max: this.props.data.max_speed
      });
      this.registerCapabilityListener("fan_speed", async (value) => {
        if (value == 0) {
          await this.bond.sendBondAction(this.getData().id, "TurnOff", {});
        } else {
          await this.bond.sendBondAction(this.getData().id, "TurnOn", {});
          await this.bond.sendBondAction(this.getData().id, "SetSpeed", { "argument": value });
        }
      });
      await this.removeCapability("fan_mode");
    } else {
      // fan without any max_speed (so assuming 3 speed mode)
      await this.addCapability("fan_mode");
      await this.removeCapability("fan_speed");
      this.registerCapabilityListener("fan_mode", async (value) => {
        if (value === 'off') {
          await this.setCapabilityValue('onoff', false);
          await this.bond.sendBondAction(this.getData().id, "TurnOff", {});
        }
        if (value === 'low') {
          await this.setCapabilityValue('onoff', true);
          await this.bond.sendBondAction(this.getData().id, "SetSpeed", { "argument": 1 });
        }

        if (value === 'medium') {
          await this.setCapabilityValue('onoff', true);
          await this.bond.sendBondAction(this.getData().id, "SetSpeed", { "argument": 50 });
        }

        if (value === 'high') {
          await this.setCapabilityValue('onoff', true);
          await this.bond.sendBondAction(this.getData().id, "SetSpeed", { "argument": 100 });
        }
      });
    }

    await this.addCapability("fan_direction");
    this.registerCapabilityListener("fan_direction", async (value) => {
      await this.bond.sendBondAction(this.getData().id, "SetDirection", { "argument": Number(value) });
    });
  }

  async updateCapabilityValues(state) {
    this.props = this.props || {};
    this.props.data = this.props.data || {};

    if (hasProperties(this.props.data, ["feature_light"]) && this.props.data.feature_light) {
      // fan with light   
      if (hasProperties(state.data, ["light"])) {
        await this.setCapabilityValue('onoff', state.data.light === 1);
      }
      if (hasProperties(this.props.data, ["feature_brightness"]) && this.props.data.feature_brightness) {

        if (hasProperties(state.data, ["brightness"])) {
          await this.setCapabilityValue('dim', state.data.brightness / 100);
        }
      }
    } else {
      // basic fan (no light)
      if (hasProperties(state.data, ["power"])) {
        await this.setCapabilityValue('onoff', state.data.power === 1);
      }
    }

    if (hasProperties(state.data, ["direction"]) && this.hasCapability('fan_direction')) {
      await this.setCapabilityValue('fan_direction', `${state.data.direction}`);
    }

    if (hasProperties(state.data, ["speed"])) {
      if (hasProperties(this.props.data, ["max_speed"]) && this.hasCapability('fan_speed')) {
        // fan with max_speed   
        await this.setCapabilityValue('fan_speed', state.data.speed);
      } else {
        // fan without any max_speed (so assuming 3 speed mode)
        if (state.data.speed == 100) {
          await this.setCapabilityValue('fan_mode', 'high');
        } else if (state.data.speed == 50) {
          await this.setCapabilityValue('fan_mode', 'medium');
        } else {
          await this.setCapabilityValue('fan_mode', 'low');
        }
      }
    }
  }
}

module.exports = FanDevice;
