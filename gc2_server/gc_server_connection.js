var influent = require('influent');
var Firebase = require('firebase');
var q = require('promised-io/promise');

/* global pubnub_client: true */
/* global MODE: true */
/* global CONNECTION_STATES: true */
/* global UINT16_MARKER_HANDSHAKE: true */
/* global UINT16_MARKER_START: true */
/* global UINT16_MARKER_END: true */
/* global BYTE_HANDSHAKE_OK: true */
/* global WRITE_INFLUXDB: true */


MODE = {
    REALTIME: 1,
    DATALOGGING: 2,
    CONNECTION_TEST: 3,
    REPORT_BATTERY: 4
};

CONNECTION_STATES = {
    CONNECTED: 0,
    READY_REALTIME: 1,
    READY_DATALOGGING: 2,
    PENDING_DATALOGGING: 3, // some more batch data is expected
    READY_BATTERY: 4
};

UINT16_MARKER_HANDSHAKE = 39780;
UINT16_MARKER_START = 6713;
UINT16_MARKER_END = 21826;
BYTE_HANDSHAKE_OK = 42;

WRITE_INFLUXDB = true;


function GcClient(socket, influx_client, config, firebase_root, logger) {
    this.socket = socket;
    this.influx_client = influx_client;
    this.config = config;
    this.logger = logger;
    
    // firebase setup
    var firebase_root_ref = new Firebase(firebase_root);
    this.firebaseRoot = firebase_root_ref;
    this.firebaseDevicesRoot = this.firebaseRoot.child('devices');

    this.state = CONNECTION_STATES.CONNECTED;
    
    this.socket_info = socket.remoteAddress + ':' + socket.remotePort;
    
    var self = this;
    
    this.socket.on('data', function(data){
        var data_length = data.length;
        self.log_info("received data, length: ", data_length, " current state: ", self.state);
    
        if(self.state == CONNECTION_STATES.CONNECTED) {
            
            // this should be equal to UINT16_MARKER_HANDSHAKE
            var marker = data.readUInt16LE(0);
            if(marker != UINT16_MARKER_HANDSHAKE) {
                // something must be wrong as marker is incorrect
                self.log_error("closing connection, handshake marker incorrect: " + marker);
                self.socket.destroy();
                
            } else {
            
                self.device_id = data.readUInt32LE(2);
                var protocol_version = data.readUInt32LE(6);
                self.log_info("device_id: " + self.device_id + " protocol_version: " + protocol_version);
                
                self.firebaseDeviceRef = self.firebaseDevicesRoot.child(self.device_id.toString());
                
                var defer = q.defer();
                
                // get the user_name (to be added as an influxdb tag)
                self.firebaseDeviceRef.once('value', function(snapshot){
                   var data = snapshot.val();
                   if(data == null || ! data.user_name) {
                       // username not present, device id is probably bad, disconnect
                       self.log_error("device id " + self.device_id + " not present, or no user_name present, disconnecting");
                       self.socket.destroy();
                   } else {
                    self.user_name = data.user_name;
                    self.owner_uid = data.owner_uid;
                    self.log_info("identified user", self.user_name, "owner_uid:", self.owner_uid);
                    defer.resolve();
                   }
                });
                
                defer.promise.then(function() {
                    
                    var mode = data.readUInt32LE(10);
                    
                    var starting_timestamp = data.readUInt32LE(14);
                    var starting_millis = data.readUInt32LE(18);
                    
                    self.starting_timestamp = starting_timestamp * 1000 + starting_millis % 1000;
                    self.starting_millis = starting_millis;
                    
                    
                    //self.log_info("initial_timestamp: ", initial_timestamp, " initial_millis: ", initial_millis);
                    
                    if( mode == MODE.REALTIME ) {
                        self.state = CONNECTION_STATES.READY_REALTIME;
                        self.log_info("realtime mode");
                        self.firebaseDeviceRef.update({
                            "last_device_update": Firebase.ServerValue.TIMESTAMP,
                            "mode": "realtime"
                        });
                        
                    } else if ( mode == MODE.DATALOGGING ) {
                        self.state = CONNECTION_STATES.READY_DATALOGGING;
                        self.log_info("datalogging mode");
                    } else if ( mode == MODE.CONNECTION_TEST ) {
                        self.log_info("connection test");
                        var random_number = data.readUInt32LE(22);
                        // write data on firebase to show we received data
                        self.firebaseDeviceRef.update({
                            "ping_test": random_number
                        });
                    }  else if( mode == MODE.REPORT_BATTERY ) {
                        self.state = CONNECTION_STATES.READY_BATTERY;
                        self.log_info("report battery");
                    } else {
                        self.log_error("unknown mode:", mode, "disconnecting");
                        self.socket.destroy();
                        return;
                    }
                    
                    // write acknowledgement byte
                    var final_byte = new Buffer(1);
                    final_byte.writeUInt8(BYTE_HANDSHAKE_OK,0);
                    self.socket.write(final_byte);       
                    
                });
                
             
            }


        
        } else if (self.state == CONNECTION_STATES.READY_DATALOGGING) {
        
            var offset = 0;

            // read battery charge
            var charged_percent = data.readUInt16LE(offset); offset += 2;
            
            // read number of seconds collected
            var data_collection_start_timestamp = data.readUInt32LE(offset) * 1000; offset += 4;
            var current_timestamp = new Date().getTime();
            var collected_duration = Math.round((current_timestamp - data_collection_start_timestamp) / 1000);

            // read starting timestamp
            var starting_timestamp = data.readUInt32LE(offset); offset += 4;
            // read starting millis
            var starting_millis = data.readUInt32LE(offset); offset += 4;
            
            self.starting_timestamp = starting_timestamp * 1000 + starting_millis % 1000;
            self.starting_millis = starting_millis;
            
            // read stats about data uploaded
            var batches_uploaded = data.readUInt16LE(offset); offset += 2;
            var error_count = data.readUInt16LE(offset); offset += 2;
            var abandon_count = data.readUInt16LE(offset); offset += 2;

            // update firebase with a few stats after influxDB writing is done
            self.firebase_update_obj = {
                "battery_charge": charged_percent / 100.0,
                "batches_uploaded": batches_uploaded,
                "error_count": error_count,
                "abandon_count": abandon_count,
                "last_upload_time": Firebase.ServerValue.TIMESTAMP,
                "collected_duration": collected_duration,
                "collection_start": data_collection_start_timestamp,
                "last_device_update": Firebase.ServerValue.TIMESTAMP,
                "mode": "night"
            };
            

            // read number of datapoints
            var num_datapoints = data.readUInt16LE(offset); offset += 2;
            // read total buffer size to expect
            var buffer_size = data.readUInt32LE(offset); offset += 4;
            // read starting marker
            var starting_marker = data.readUInt16LE(offset); offset += 2;
            
            if(starting_marker != UINT16_MARKER_START) {
                console.log("ERROR starting marker incorrect");
            }

            self.expect_buffer_size = buffer_size - offset;
            self.data_buffer = new Buffer(buffer_size);
            self.data_buffer_offset = 0;
            self.num_datapoints = num_datapoints;
            self.state = CONNECTION_STATES.PENDING_DATALOGGING;
            
            self.log_info("datalogging header", new Date(),
                        "charged_percent:", charged_percent / 100.0,
                        "num_datapoints:", num_datapoints,
                        "total buffer_size:", buffer_size,
                        "expect buffer_size:", self.expect_buffer_size);
            
            self.log_info("stats:", "batches: ", batches_uploaded,
                                  "errors: ", error_count,
                                  "abandons: ", abandon_count);
            
            if( data_length > offset || data_length == buffer_size) {
                // more data is available than what we read in the buffer
                data.copy(self.data_buffer, self.data_buffer_offset, offset);
                self.data_buffer_offset += data_length - offset;
            } 
            
            if (data_length == buffer_size) {
                // all done
                self.log_info("ready to process buffer");
                self.process_datalogging_buffer();
                self.state = CONNECTION_STATES.READY_DATALOGGING;                
            }
            
        } else if (self.state == CONNECTION_STATES.PENDING_DATALOGGING) {
        
            data.copy(self.data_buffer, self.data_buffer_offset);
            self.data_buffer_offset += data_length;
            
            self.log_info("appended to data_buffer: ", data_length,
                        "data_buffer_offset:", self.data_buffer_offset);
            
            if(self.data_buffer_offset == self.expect_buffer_size) {
                // received full data size
                self.log_info("ready to process buffer");
                
                self.process_datalogging_buffer();
                
                self.state = CONNECTION_STATES.READY_DATALOGGING;
            }
        
        } else if (self.state == CONNECTION_STATES.READY_REALTIME) {
            offset = 0;
            self.read_data_packet(data, offset, true, true, false);
        } else if( self.state == CONNECTION_STATES.READY_BATTERY ) {
            self.ready_battery_level(data);
        }
    });
    
    
    this.ready_battery_level = function(data) {
        // read battery charge
        var charged_percent = data.readUInt16LE(0) / 100.0;
        self.log_info("battery level: ", charged_percent);
        
        self.firebaseDeviceRef.update({
            "battery_charge": charged_percent,
            "last_device_update": Firebase.ServerValue.TIMESTAMP,
            "mode": "online"       
        });
    }
    
    this.process_datalogging_buffer = function() {
        
        // reset the measurements array
        self.measurements = [];
    
        var offset = 0;
        for(var i = 0; i < self.num_datapoints; i++) {
            offset = self.read_data_packet(self.data_buffer, offset, false, false, true);
        }
        
        // read end marker
        var end_marker = self.data_buffer.readUInt16LE(offset); offset += 2;
        if( end_marker != UINT16_MARKER_END ) {
            self.log_error("invalid end marker");
            return;
        }
        
        
        var final_byte = new Buffer(1);
        final_byte.writeUInt8(1,0);
        self.socket.write(final_byte);
        
        self.log_info("processed datalogging buffer");
        self.log_info("writing to influxdb");
        
        // add data for battery
        var tags = {user: self.user_name,
                    env:  self.config.env};        
        self.measurements.push({
            key: "battery",
            tags: tags,
            fields: {
                charge: new influent.Value(self.firebase_update_obj.battery_charge, influent.type.FLOAT64)
            },
        });        
        
    
        if(WRITE_INFLUXDB) {
            self.influx_client.writeMany(self.measurements).then(function() {
                self.log_info("done writing to influxDB");
                self.firebaseDeviceRef.update(self.firebase_update_obj);
            });                    
        }
    }
    
    this.read_data_packet = function(data, offset, print_data, publish, push_to_influxdb) {
        var milliseconds = data.readUInt32LE(offset); offset += 4;
        
        var diff = milliseconds - self.starting_millis;
        var timestamp = self.starting_timestamp + diff;
        var datetime = new Date(timestamp);
        
        // read EMG value
        var emg_value = data.readUInt16LE(offset); ; offset += 2;
        
        // read gyro max
        var gyro_max_adj = data.readInt16LE(offset); offset += 2;
        // read accel values
        var accel_x_adj = data.readInt16LE(offset); offset += 2;
        var accel_y_adj = data.readInt16LE(offset); offset += 2;
        var accel_z_adj = data.readInt16LE(offset); offset += 2;
        
        var gyro_max = gyro_max_adj / 100.0;
        var accel_x = accel_x_adj / 1000.0;
        var accel_y = accel_y_adj / 1000.0;
        var accel_z = accel_z_adj / 1000.0;
        
        var button_state = data.readUInt8(offset); offset += 1;
        
        
        self.log_debug("time:", datetime,
                       "millisecond diff:", diff,
                       "emg_value:", emg_value,
                       "gyro_max:", gyro_max,
                       "accel_x:", accel_x,
                       "accel_y:", accel_y,
                       "accel_z:", accel_z,
                       "button_state:", button_state);    

        if(publish) {
        
            // publish to firebase
            this.firebaseDeviceRef.update({
                "emg_value": emg_value,
                "gyro_max": gyro_max,
                "accel_x": accel_x,
                "accel_y": accel_y,
                "accel_z": accel_z,
                "button_state": button_state,
                "datapoint_time": timestamp
            });
        
        }

        var tags = {username: self.user_name,
                    env:  self.config.env};
        
        if(push_to_influxdb) {
            var timestamp_nanos = datetime.getTime().toString() + "000000";
            // EMG sensor value
            self.measurements.push({
                key: "emg",
                tags: tags,
                fields: {
                    emg_value: new influent.Value(emg_value, influent.type.INT64),
                },
                timestamp: timestamp_nanos
            });
            self.measurements.push({
                key: "imu",
                tags: tags,
                fields: {
                    gyro: new influent.Value(gyro_max, influent.type.FLOAT64),
                    accel_x: new influent.Value(accel_x, influent.type.FLOAT64),
                    accel_y: new influent.Value(accel_y, influent.type.FLOAT64),
                    accel_z: new influent.Value(accel_z, influent.type.FLOAT64),
                },
                timestamp: timestamp_nanos
            });
        }

        return offset;
    };
    
    this.socket.on('close', function(data) {
        self.log_info("connection closed");
    });
    
    this.socket.on('error', function(error) {
        self.log_error(error);
    });
    

    this.log_base = function(level, args) {
        var args = Array.prototype.slice.call(args);
        
        // figure out what we know about this client
        if(self.device_id) {
            args.unshift(self.device_id);
        }
        if(self.owner_uid) {
            args.unshift(self.owner_uid);
        }
        args.unshift(self.socket_info);
        self.logger.log(level, args.join(' '));
    }

    this.log_debug = function() {
        self.log_base('debug', arguments);
    }

    this.log_info = function() {
        self.log_base('info', arguments);
    }
    
    this.log_error = function() {
        self.log_base('error', arguments);
    }
    
}

module.exports = GcClient;