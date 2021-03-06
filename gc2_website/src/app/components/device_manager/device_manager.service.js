/* globals Firebase: false */
/* globals spark: false */
/* globals angular */

(function() {
    'use strict';

    angular
        .module('gc2Website')
        .service('device_manager', device_manager);

    /** @ngInject */
    function device_manager(firebase_root, firebase_auth, $log, $q, $timeout) {
        var root_ref = new Firebase(firebase_root);
        var devices_ref = root_ref.child('devices');
        var servers_ref = root_ref.child('servers');
        var spark_login_done = false;

        var self = this;

        var DEVICE_VERIFY_NUM_TASKS = 9;

        this.spark_login = function(particle_access_token) {
            $log.info("logging in with token: ", particle_access_token);
            return spark.login({
                accessToken: particle_access_token
            });
        };

        this.get_servers_ref = function() {
            return servers_ref;
        }

        this.get_device_ref = function(device_id) {
            return devices_ref.child(device_id);
        };


        // verify that default device is online and configured (before starting realtime/batch mode)
        this.verify_device = function(uid) {
            var defer = $q.defer();

            // retrieve default device

            var user_ref = firebase_auth.get_user_ref(uid);
            user_ref.once("value", function(snapshot) {
                var user_data = snapshot.val();

                defer.notify({
                    status: "Logging in to Particle",
                    task: 1,
                    total: DEVICE_VERIFY_NUM_TASKS
                });

                var login_defer = $q.defer();
                if (!spark_login_done) {
                    // login to spark
                    $log.info("logging in to particle");
                    var access_token = user_data.particle_access_token;
                    if (!access_token) {
                        defer.reject({
                            message: "No Particle Access Token",
                            go_settings: true
                        });
                    }
                    else {
                        spark.login({
                            accessToken: access_token
                        }).then(
                            function(token) {
                                $log.info("verify_device: spark login successful ", token);
                                spark_login_done = true;
                                login_defer.resolve();
                            },
                            function(err) {
                                defer.reject({
                                    message: "Couldn't login to Particle, please check Particle Access Token",
                                    api_error: err,
                                    go_settings: true
                                });
                            }
                        );
                    }
                }
                else {
                    // no need to login
                    $log.info("particle login already done");
                    login_defer.resolve();
                }

                defer.notify({
                    status: "Retrieving device information",
                    task: 2,
                    total: DEVICE_VERIFY_NUM_TASKS
                });
                login_defer.promise.then(function() {
                    // get device id 
                    if (!user_data.device_id || !user_data.device_name) {
                        defer.reject({
                            message: "No device configured, please check settings.",
                            go_settings: true
                        });
                    }
                    else {
                        defer.notify({
                            status: "Checking device status",
                            task: 3,
                            total: DEVICE_VERIFY_NUM_TASKS
                        });
                        var device_name = user_data.device_name;
                        spark.getDevice(device_name, function(err, device) {
                            if (err) {
                                $log.error("verify_device error: ", err);
                                defer.reject({
                                    message: "Couldn't obtain device details ",
                                    api_error: err.message,
                                    device_name: device_name,
                                    go_settings: true
                                });
                            }
                            else {
                                self.check_device_connectivity(defer, device, device_name, user_data.device_id, user_data, uid);
                            }
                        });
                    }
                });


            });

            return defer.promise;
        };


        this.check_device_connectivity = function(defer, device, device_name, device_id, user_data, uid) {
            defer.notify({
                status: "Checking that device is online",
                task: 4,
                total: DEVICE_VERIFY_NUM_TASKS
            });
            if (!device.connected) {
                defer.reject({
                    message: "Device is not connected",
                    device_name: device_name,
                    retry: true
                });
            }
            else {
                // check whether device setup has been done
                device.getVariable("setup_done", function(err, data) {
                    if (err) {
                        defer.reject({
                            message: "Could not check whether device setup was done",
                            api_error: err.message,
                            device_name: device_name
                        });
                    }
                    else {
                        $log.info("retrieved setup_done variable: ", data);
                        if (data.result == 1) {
                            self.check_battery_charge(defer, device, device_name, device_id, user_data, uid);
                        }
                        else {
                            defer.reject({
                                message: "Device setup not done",
                                device_name: device_name,
                                go_settings: true
                            });
                        }

                    }
                });

            }
        };

        this.check_battery_charge = function(defer, device, device_name, device_id, user_data, uid) {
            defer.notify({
                status: "Checking battery level",
                task:5,
                total:DEVICE_VERIFY_NUM_TASKS
            });
            
            device.getVariable("bat_charge", function(err,data) {
               if(err) {
                   defer.reject({
                       message: "Could not check battery level",
                       api_error: err.message,
                       device_name: device_name,
                       retry: true
                   });
               } else {
                   var batt_level = data.result;
                   var device_ref = self.get_device_ref(device_id);
                   device_ref.update({battery_charge: batt_level});
                   $log.info("got battery level: ", batt_level);
                   self.check_device_entry(defer, device, device_name, device_id, user_data, uid);
               }
            });
        };

        this.check_device_entry = function(defer, device, device_name, device_id, user_data, uid) {
            defer.notify({
                status: "Checking device node",
                task: 6,
                total: DEVICE_VERIFY_NUM_TASKS
            });            
            
            devices_ref.child(device_id).once('value', function(snapshot) {
                var data = snapshot.val();
                // ensure we have device_name, owner_uid, and user_name
                if( !data.device_name ) {
                    defer.reject({
                       message: "Device name not set",
                       device_name: device_name,
                       go_settings: true
                    });
                }
                if( !data.owner_uid ) {
                    defer.reject({
                       message: "Owner UID not set",
                       device_name: device_name,
                       go_settings: true
                    });
                }
                if( !data.user_name ) {
                    defer.reject({
                       message: "Username not set",
                       device_name: device_name,
                       go_settings: true
                    });
                }
                
                // go to next step
                self.check_server(defer, device, device_name, device_id, user_data, uid);
                
                
            }, function(err) {
                defer.reject({
                   message: "Could not check device node",
                   api_error: err.message,
                   device_name: device_name
                });
            });
        };

        this.check_server = function(defer, device, device_name, device_id, user_data, uid) {
            $log.info("check_server, uid:", uid);
            
            // do a connection test with the server
            defer.notify({
                status: "Checking server setup",
                task: 7,
                total: DEVICE_VERIFY_NUM_TASKS
            });
            if (!user_data.server) {
                defer.reject({
                    message: "No server selected",
                    go_settings: true
                });
            }
            else {

                var chosen_server_ref = self.get_servers_ref().child(user_data.server);
                chosen_server_ref.once("value", function(snapshot) {
                    var server_data = snapshot.val();
                    if (!server_data.online) {
                        defer.reject({
                            message: "Server " + server_data.hostname + " not online",
                            go_settings: true
                        });
                    }
                    else {
                        var max_int32 = 2147483647;
                        var random_number = Math.floor((Math.random() * max_int32) + 1).toString();

                        // try connection test
                        defer.notify({
                            status: "Performing connection test",
                            task: 8,
                            total: DEVICE_VERIFY_NUM_TASKS
                        });

                        // set a timeout, so that we can give up after some time
                        var timeout_handler = $timeout(function() {
                            defer.reject({
                                message: "Server communication test failed (timeout)",
                                device_name: device_name
                            });
                        }, 5000);

                        // listen for updates on the device node
                        var device_ref = self.get_device_ref(device_id);
                        var on_function = device_ref.on("value", function(snapshot) {
                           var data = snapshot.val();
                           if(data.ping_test == Number(random_number)) {
                               $log.info("connection test successful");
                               device_ref.off("value", on_function);
                               $timeout.cancel(timeout_handler);
                               defer.resolve({
                                   message:"Device ready",
                                   device: device,
                                   device_id: device_id
                               });
                           }
                        });



                        device.callFunction("conn_test", random_number).then(
                            function() {
                                $log.info("called conn_test function");
                                
                            }, function(error) {
                                defer.reject({
                                    message: "Could not start connection test on device",
                                    device_name: device_name,
                                    api_error: error.message
                                });
                            }
                        );
                    }
                });
            }
        };

        // retrieve existing device id, or create new one
        this.get_device_id = function(device, uid) {
            $log.info("get_device_id, uid:", uid);
            
            var defer = $q.defer();
            
            // find out whether device already has an id
            // get the gc_device_id variable
            device.getVariable("gc_device_id", function(err,data) {
                if(err) {
                    $log.error("couldn't get device id: ", err);
                    defer.reject(err.message);
                } else {
                    if(data.result > 0) {
                        // device already has an id
                        $log.info("device ", device.name, " has existing id: ", data.result);
                        defer.resolve(data.result);
                    } else {
                        // create new id after checking firebase
                        // get snapshot under devices
                        devices_ref.once("value", function(snapshot) {
                            // identify unique number
                            var max_int32 = 2147483647;
                            var tentative_device_id = Math.floor((Math.random() * max_int32) + 1).toString();
                            while (snapshot.hasChild(tentative_device_id)) {
                                tentative_device_id = Math.floor((Math.random() * max_int32) + 1).toString();
                            }
                            // device id should be unique
                            var device_id = tentative_device_id;
                            $log.info("generated device_id: ", device_id);
                            
                            defer.resolve(device_id);
                            
                        });
                        
                    }
                }
            });
            
            return defer.promise;
        };


        this.save_settings = function(device, uid, server_key, server_data, user_name, particle_access_token) {
            var defer = $q.defer();
            
            $log.info("selecting device: ", device.name, " uid: " , uid, " server_data: ", server_data,
                      "user_name:", user_name);
            
            
            var device_id_promise = self.get_device_id(device, uid);
            
            device_id_promise.then(function(device_id) {

                $log.info("device_id: ", device_id);

                // call spark function to set config
                // call "set_config" function
                var config_string = server_data.hostname + "," + server_data.port + "," + device_id;
                device.callFunction('set_config', config_string).then(
                    function(result) {
                        $log.info("device_id result: ", result);
                        $log.info("associated device ", device.name, " with id: ", device_id);

                        // create firebase entry
                        var device_ref = devices_ref.child(device_id);
                        device_ref.set({
                            owner_uid: uid,
                            device_name: device.name,
                            user_name: user_name
                        });

                        var user_ref = firebase_auth.get_user_ref(uid);
                        var update_data = {
                            device_name: device.name,
                            device_id: device_id,
                            user_name: user_name,
                            particle_access_token: particle_access_token,
                            server: server_key
                        };
                        $log.info("updating user ref with ", update_data);
                        try {
                        user_ref.update(update_data, function(error) {
                            if (error) {
                                $log.error("Could not update user ref: ", error);
                                defer.reject(error);
                            } else {
                                $log.info("update of user ref complete");
                                defer.resolve(device_id);        
                            }
                        });
                        } catch (err) {
                            $log.error("caught error", err);
                            defer.reject("user ref update failed");
                        }

                        
                    },
                    function(error) {
                        $log.info("device_id error: ", error);
                        defer.reject(error.message);
                    });
                
            }, function(error) {
                $log.error("couldn't get device_id: ", error);
                defer.reject(error);
            });
            
            return defer.promise;

        };

    }


})();
